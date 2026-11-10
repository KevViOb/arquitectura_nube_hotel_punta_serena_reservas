// API REST del Hotel Punta Serena (Node.js con Express).
// Escucha en el puerto 3000 de la red interna de Docker; desde afuera solo se
// llega a través del proxy con WAF en el puerto 443.

const express = require('express');
const { consultar } = require('./db');
const { manejarErrores, ErrorHttp } = require('./errores');
const auth = require('./auth');
const reservas = require('./reservas');
const admin = require('./admin');

if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL en el entorno.');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET debe existir y tener al menos 32 caracteres.');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);                 // el proxy Nginx informa la dirección real del cliente
app.use(express.json({ limit: '20kb' }));

// Salud del sistema: estado de la API y de la base. Sirve para detectar fallas
// y para que la interfaz muestre el aviso de contingencia.
app.get('/api/salud', async (req, res) => {
  try {
    await consultar('SELECT 1');
    res.json({ api: 'disponible', base: 'disponible' });
  } catch {
    res.status(503).json({ api: 'disponible', base: 'no disponible' });
  }
});

app.post('/api/sesion', auth.iniciarSesion);
app.get('/api/sesion', auth.autenticar, auth.sesionActual);
app.delete('/api/sesion', auth.cerrarSesion);

app.use('/api', reservas);
app.use('/api', admin);

app.use('/api', () => { throw new ErrorHttp(404, 'Ruta no encontrada.'); });
app.use(manejarErrores);

const puerto = Number(process.env.PUERTO || 3000);
const servidor = app.listen(puerto, () => console.log(`API escuchando en el puerto ${puerto}`));

// Docker envía SIGTERM al detener el contenedor: se cierran las conexiones en orden.
process.on('SIGTERM', () => {
  servidor.close(() => process.exit(0));
});
