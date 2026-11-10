// Conexión a PostgreSQL en Supabase a través del pooler en modo sesión.
// DATABASE_URL incluye sslmode=verify-full y sslrootcert: la conexión va cifrada
// y se verifica el certificado del servidor.

const { Pool, types } = require('pg');

// Las columnas date se devuelven como texto 'AAAA-MM-DD'. Si se convirtieran a
// Date de JavaScript, la zona horaria podría correr la fecha un día.
types.setTypeParser(1082, (valor) => valor);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,                         // el pooler gratuito tiene pocas conexiones
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: 5000,
});

pool.on('error', (e) => console.error('Conexión inactiva con la base perdida:', e.message));

// Día actual en Costa Rica, calculado por la base. Supabase trabaja en UTC, así
// que no se usa current_date.
const HOY = "(now() AT TIME ZONE 'America/Costa_Rica')::date";

function consultar(texto, valores) {
  return pool.query(texto, valores);
}

// Ejecuta fn dentro de una transacción: si algo falla, no queda nada a medias.
async function enTransaccion(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

module.exports = { pool, consultar, enTransaccion, HOY };
