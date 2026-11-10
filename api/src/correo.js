// Correo de confirmación (RF04) por la API HTTPS de Mailtrap Email Sandbox.
// El sandbox retiene los correos en una bandeja de pruebas: nunca llegan a
// destinatarios reales. Si el envío falla, la reserva sigue válida y queda
// marcada con correo pendiente para que recepción lo reenvíe.

const URL_SANDBOX = 'https://sandbox.api.mailtrap.io/api/send';

function formatearFecha(fechaTexto) {
  const d = new Date(`${fechaTexto}T12:00:00Z`);
  return new Intl.DateTimeFormat('es-CR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(d);
}

// reserva: { codigo, nombre_completo, correo, numero, tipo, fecha_entrada, fecha_salida, personas, tarifa_aplicada }
async function enviarConfirmacion(reserva) {
  const { MAILTRAP_TOKEN, MAILTRAP_INBOX_ID, CORREO_REMITENTE } = process.env;
  if (!MAILTRAP_TOKEN || !MAILTRAP_INBOX_ID) {
    console.warn('Correo no configurado: la reserva queda con correo pendiente.');
    return false;
  }
  const horaEntrada = process.env.HORA_ENTRADA || '14:00';
  const horaSalida = process.env.HORA_SALIDA || '12:00';

  const texto = [
    `Hola, ${reserva.nombre_completo}:`,
    '',
    'Su reserva en el Hotel Punta Serena está confirmada.',
    '',
    `Código de reserva: ${reserva.codigo}`,
    `Habitación: ${reserva.numero} (${reserva.tipo})`,
    `Entrada: ${formatearFecha(reserva.fecha_entrada)}, a partir de las ${horaEntrada}`,
    `Salida: ${formatearFecha(reserva.fecha_salida)}, a más tardar a las ${horaSalida}`,
    `Personas: ${reserva.personas}`,
    `Total: USD ${reserva.tarifa_aplicada}`,
    '',
    'Para modificar o cancelar, escríbanos por WhatsApp indicando su código de reserva.',
  ].join('\n');

  try {
    const respuesta = await fetch(`${URL_SANDBOX}/${encodeURIComponent(MAILTRAP_INBOX_ID)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MAILTRAP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: { email: CORREO_REMITENTE, name: 'Hotel Punta Serena' },
        to: [{ email: reserva.correo, name: reserva.nombre_completo }],
        subject: `Confirmación de su reserva ${reserva.codigo}`,
        text: texto,
        category: 'confirmacion',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!respuesta.ok) console.warn(`Mailtrap respondió ${respuesta.status}: correo pendiente.`);
    return respuesta.ok;
  } catch (e) {
    console.warn('Mailtrap no disponible: correo pendiente.', e.message);
    return false;
  }
}

module.exports = { enviarConfirmacion };
