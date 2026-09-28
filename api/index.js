// Vercel Node runtime invoca con (req, res) estilo Node, no con evento Lambda.
// Express ya es un handler (req, res), así que se pasa directo.
const app = require('../server');

module.exports = (req, res) => app(req, res);
