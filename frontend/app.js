// Consulta /api/salud y muestra el aviso de contingencia si la base no responde.
// El script va en un archivo aparte porque la política de seguridad de contenido
// del proxy no permite scripts en línea.

const estado = document.getElementById('estado');

fetch('/api/salud')
  .then((r) => r.json().then((datos) => ({ ok: r.ok, datos })))
  .then(({ ok, datos }) => {
    if (ok) {
      estado.textContent = 'Sistema disponible.';
      estado.className = 'estado disponible';
    } else {
      estado.textContent = `Sistema en contingencia: la base de datos está ${datos.base}. Recepción trabaja con la planilla.`;
      estado.className = 'estado contingencia';
    }
  })
  .catch(() => {
    estado.textContent = 'Sistema en contingencia: la API no responde. Recepción trabaja con la planilla.';
    estado.className = 'estado contingencia';
  });
