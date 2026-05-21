require('dotenv').config();
const { Command } = require('commander');
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bodyParser = require('body-parser');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const { Pool } = require('pg');

// Зчитування параметрів командного рядка
const program = new Command();
program
  .requiredOption('-h, --host <type>', 'адреса сервера')
  .requiredOption('-p, --port <number>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'шлях до директорії кешу')
  .parse(process.argv);

const options = program.opts();

const app = express();

// Налаштування пулу підключень до PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432'),
});

// Перевірка та створення директорії кешу (для фото)
if (!fs.existsSync(options.cache)) {
  fs.mkdirSync(options.cache, { recursive: true });
}

// Swagger налаштування
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Inventory WebAPI',
    version: '1.0.0',
    description: 'Система інвентаризації (PostgreSQL)',
  },
  servers: [{ url: `http://${options.host}:${options.port}` }],
};

const specs = swaggerJsdoc({ swaggerDefinition, apis: [] });
app.use('/docs', swaggerUi.serve, swaggerUi.setup(specs));

// Налаштування зберігання файлів за допомогою Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, options.cache),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// Middleware
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// 1. POST /register — Реєстрація нового пристрою
app.post('/register', upload.single('photo'), async (req, res) => {
  const { inventory_name, description } = req.body;

  if (!inventory_name) {
    return res.status(400).send('Bad Request: inventory_name is required');
  }

  try {
    const query = 'INSERT INTO items (inventory_name, description, photo) VALUES ($1, $2, $3) RETURNING *;';
    const values = [inventory_name, description || "", req.file ? req.file.filename : null];
    const result = await pool.query(query, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. GET /inventory — Отримання списку всіх речей
app.get('/inventory', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM items');
    const list = result.rows.map(item => ({
      ...item,
      photo_url: item.photo ? `http://${options.host}:${options.port}/inventory/${item.id}/photo` : null
    }));
    res.status(200).json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. GET /inventory/:id — Отримання конкретної речі
app.get('/inventory/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM items WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Not Found');
    }
    const item = result.rows[0];
    res.status(200).json({
      ...item,
      photo_url: item.photo ? `http://${options.host}:${options.port}/inventory/${item.id}/photo` : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. PUT /inventory/:id — Оновлення текстових даних речі
app.put('/inventory/:id', async (req, res) => {
  const { inventory_name, description } = req.body;
  try {
    const query = 'UPDATE items SET inventory_name = COALESCE($1, inventory_name), description = COALESCE($2, description) WHERE id = $3 RETURNING *;';
    const result = await pool.query(query, [inventory_name, description, req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Not Found');
    }
    res.status(200).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. GET /inventory/:id/photo — Отримання фотографії
app.get('/inventory/:id/photo', async (req, res) => {
  try {
    const result = await pool.query('SELECT photo FROM items WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0 || !result.rows[0].photo) {
      return res.status(404).send('Photo Not Found');
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.sendFile(path.resolve(options.cache, result.rows[0].photo));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. PUT /inventory/:id/photo — Оновлення фотографії
app.put('/inventory/:id/photo', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No photo uploaded');
  }
  try {
    const query = 'UPDATE items SET photo = $1 WHERE id = $2 RETURNING *;';
    const result = await pool.query(query, [req.file.filename, req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Not Found');
    }
    res.status(200).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. DELETE /inventory/:id — Видалення речі
app.delete('/inventory/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).send('Not Found');
    }
    res.status(200).send('Deleted');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. POST /search — URL-encoded пошук
app.post('/search', async (req, res) => {
  const { id, has_photo } = req.body;
  try {
    const result = await pool.query('SELECT * FROM items WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).send('Not Found');
    }
    let item = { ...result.rows[0] };
    if (has_photo !== 'on') {
      delete item.photo;
    }
    res.status(200).json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обробка непідтримуваних методів (405 Method Not Allowed)
app.use((req, res) => {
  res.status(405).send('Method Not Allowed');
});

// Запуск сервера
app.listen(options.port, options.host, () => {
  console.log(`\x1b[32m%s\x1b[0m`, `Server running at http://${options.host}:${options.port}`);
  console.log(`\x1b[36m%s\x1b[0m`, `Swagger docs at http://${options.host}:${options.port}/docs`);
});