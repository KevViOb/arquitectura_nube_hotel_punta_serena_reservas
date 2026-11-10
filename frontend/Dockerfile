# Frontend del Hotel Punta Serena: archivos estáticos servidos por Nginx en el puerto 80.
# En esta etapa es un marcador que consulta el estado del sistema. En la
# siguiente, la interfaz React se compila con Vite en una etapa previa de este
# mismo Dockerfile y el resultado se copia aquí.
FROM nginx:1.30-alpine

COPY index.html app.js estilos.css /usr/share/nginx/html/
EXPOSE 80
