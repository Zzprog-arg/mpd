# MPEG-DASH a HLS

Servidor Node.js + Express + FFmpeg para retransmitir fuentes MPEG-DASH autorizadas como HLS.

## Ejecutar

```bash
pnpm install
node server.js
```

Requiere `ffmpeg` instalado en el sistema. En Render, usar **Docker** para instalarlo automáticamente.

## API

- `GET /health` → `{ "status": "ok" }`
- `GET /stream?url=https%3A%2F%2F...%2Fstream.mpd` → crea o reutiliza una sesión y devuelve `playlist`.
- `GET /hls/{id}/index.m3u8` → playlist compatible con VLC y Android/ExoPlayer.

Ejemplo:

```bash
curl --get 'https://TU-SERVICIO.onrender.com/stream' --data-urlencode 'url=https://ejemplo.com/live/channel.mpd'
```

La URL de origen debe ser HTTP(S), terminar en `.mpd` y resolver a una dirección pública. Se bloquean localhost, rangos privados y destinos link-local para evitar SSRF. Las sesiones se identifican por hash de la fuente, reutilizan procesos activos y se limpian tras `SESSION_TTL_MS` (10 minutos por defecto) sin actividad.

## Render

1. Subir el repositorio a GitHub.
2. Crear un Web Service en Render y seleccionar **Docker**.
3. Publicar el servicio en el puerto `3000` (Render proporciona `PORT`).
4. Configurar el health check como `/health`.

Variables opcionales: `SESSION_TTL_MS`, `HLS_ROOT`, `FFMPEG_PATH`.

Usá únicamente fuentes para las que tengas autorización de retransmisión y sus credenciales correspondientes.
