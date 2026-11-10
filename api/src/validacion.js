// Validación de entrada. Todo dato que llega del navegador se revisa aquí antes
// de tocar la base; las consultas además son parametrizadas.

const { ErrorHttp } = require('./errores');

const ZONA = 'America/Costa_Rica';

function invalido(mensaje) {
  return new ErrorHttp(400, mensaje);
}

// Rechaza campos que la operación no admite.
function soloCampos(cuerpo, permitidos) {
  if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
    throw invalido('Se esperaba un objeto JSON.');
  }
  const extra = Object.keys(cuerpo).filter((k) => !permitidos.includes(k));
  if (extra.length) throw invalido(`Campo no permitido: ${extra[0]}.`);
  return cuerpo;
}

function texto(valor, nombre, { min = 1, max = 120 } = {}) {
  if (typeof valor !== 'string') throw invalido(`${nombre} es obligatorio.`);
  const limpio = valor.trim();
  if (limpio.length < min || limpio.length > max) {
    throw invalido(`${nombre} debe tener entre ${min} y ${max} caracteres.`);
  }
  return limpio;
}

function entero(valor, nombre, { min, max }) {
  const n = typeof valor === 'string' && /^\d+$/.test(valor) ? Number(valor) : valor;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw invalido(`${nombre} debe ser un entero entre ${min} y ${max}.`);
  }
  return n;
}

function precio(valor, nombre) {
  const n = typeof valor === 'string' ? Number(valor) : valor;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 100000 || Math.round(n * 100) !== n * 100) {
    throw invalido(`${nombre} debe ser un monto positivo con máximo dos decimales.`);
  }
  return n.toFixed(2);
}

function booleano(valor, nombre) {
  if (typeof valor !== 'boolean') throw invalido(`${nombre} debe ser verdadero o falso.`);
  return valor;
}

// Fecha en formato AAAA-MM-DD que exista en el calendario.
function fecha(valor, nombre) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw invalido(`${nombre} debe tener el formato AAAA-MM-DD.`);
  }
  const d = new Date(`${valor}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    throw invalido(`${nombre} no es una fecha válida.`);
  }
  return valor;
}

function correo(valor) {
  const c = texto(valor, 'El correo', { min: 6, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) throw invalido('El correo no tiene un formato válido.');
  return c;
}

function telefono(valor) {
  const t = texto(valor, 'El teléfono', { min: 8, max: 20 });
  if (!/^\+?[0-9 ]{8,19}$/.test(t)) throw invalido('El teléfono solo admite números, espacios y el signo +.');
  return t;
}

function codigoReserva(valor) {
  if (typeof valor !== 'string' || !/^[A-HJ-NP-Z2-9]{8}$/.test(valor.toUpperCase())) {
    throw invalido('El código de reserva no es válido.');
  }
  return valor.toUpperCase();
}

function uno(valor, nombre, opciones) {
  if (!opciones.includes(valor)) throw invalido(`${nombre} debe ser uno de: ${opciones.join(', ')}.`);
  return valor;
}

// Fecha de hoy en Costa Rica, en formato AAAA-MM-DD.
function hoyCostaRica() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date());
}

// Hora actual en Costa Rica, en formato HH:MM.
function horaCostaRica() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date());
}

function sumarDias(fechaTexto, dias) {
  const d = new Date(`${fechaTexto}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function diasEntre(desde, hasta) {
  return Math.round((new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / 86400000);
}

// Reglas comunes a cualquier estancia: salida después de la entrada, máximo
// 30 noches y no más de 18 meses hacia adelante.
function estancia(entrada, salida) {
  const noches = diasEntre(entrada, salida);
  if (noches < 1) throw invalido('La fecha de salida debe ser posterior a la de entrada.');
  if (noches > 30) throw invalido('La estancia máxima es de 30 noches.');
  if (entrada > sumarDias(hoyCostaRica(), 548)) throw invalido('Solo se reciben reservas hasta 18 meses adelante.');
  return noches;
}

module.exports = {
  soloCampos, texto, entero, precio, booleano, fecha, correo, telefono, codigoReserva, uno,
  hoyCostaRica, horaCostaRica, sumarDias, diasEntre, estancia, invalido,
};
