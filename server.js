const express = require('express')
const dns = require('node:dns').promises
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const app = express()

const PORT = Number(process.env.PORT || 3000)
const HLS_ROOT = path.join(process.env.HLS_ROOT || '/tmp', 'hls-streams')
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 10 * 60 * 1000)

const sessions = new Map()

fs.mkdirSync(HLS_ROOT, { recursive: true })

function isPrivateAddress(address) {
  const normalized = address.replace(/^::ffff:/, '')

  if (normalized === '::1' || normalized === 'localhost') {
    return true
  }

  if (/^(10|127)\./.test(normalized)) {
    return true
  }

  if (/^192\.168\./.test(normalized)) {
    return true
  }

  const octets = normalized.split('.').map(Number)

  if (
    octets.length === 4 &&
    octets[0] === 172 &&
    octets[1] >= 16 &&
    octets[1] <= 31
  ) {
    return true
  }

  if (
    normalized.startsWith('169.254.') ||
    normalized.startsWith('0.')
  ) {
    return true
  }

  if (
    normalized.includes(':') &&
    (
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    )
  ) {
    return true
  }

  return false
}

async function validateSource(rawUrl) {
  let source

  try {
    source = new URL(rawUrl)
  } catch {
    throw new Error('La URL del MPD no es válida')
  }

  if (
    source.protocol !== 'https:' &&
    source.protocol !== 'http:'
  ) {
    throw new Error('Solo se aceptan URLs HTTP(S)')
  }

  if (!source.pathname.toLowerCase().endsWith('.mpd')) {
    throw new Error('La URL debe apuntar a un archivo .mpd')
  }

  const addresses = await dns.lookup(source.hostname, {
    all: true
  })

  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new Error('Destino no permitido')
  }

  return source
}

function sessionId(source) {
  return crypto
    .createHash('sha256')
    .update(source.toString())
    .digest('hex')
    .slice(0, 16)
}

function decodeHeaders(source) {
  const encoded = source.searchParams.get('headers')

  if (!encoded) {
    return {}
  }

  try {
    const normalized = encoded
      .replace(/-/g, '+')
      .replace(/_/g, '/')

    const json = Buffer
      .from(normalized, 'base64')
      .toString('utf8')

    const parsed = JSON.parse(json)

    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    return parsed
  } catch (error) {
    console.error(
      '[headers] No se pudieron decodificar los headers:',
      error.message
    )

    return {}
  }
}

function buildFFmpegHeaders(headers) {
  const allowed = {}

  for (const [key, value] of Object.entries(headers)) {
    if (
      typeof key !== 'string' ||
      typeof value !== 'string'
    ) {
      continue
    }

    const normalizedKey = key.trim()

    if (!normalizedKey) {
      continue
    }

    const lower = normalizedKey.toLowerCase()

    if (
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'connection'
    ) {
      continue
    }

    allowed[normalizedKey] = value
  }

  if (Object.keys(allowed).length === 0) {
    return null
  }

  return Object.entries(allowed)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n') + '\r\n'
}

function cleanup(id) {
  const session = sessions.get(id)

  if (!session) {
    return
  }

  clearTimeout(session.timer)

  if (
    session.process &&
    !session.process.killed &&
    session.process.exitCode === null
  ) {
    session.process.kill('SIGTERM')
  }

  fs.rmSync(session.output, {
    recursive: true,
    force: true
  })

  sessions.delete(id)

  console.log(`[stream] sesión finalizada id=${id}`)
}

function touch(session) {
  clearTimeout(session.timer)

  session.timer = setTimeout(() => {
    cleanup(session.id)
  }, SESSION_TTL_MS)
}

async function startSession(source) {
  const id = sessionId(source)

  const existing = sessions.get(id)

  if (existing) {
    touch(existing)
    return existing
  }

  const output = path.join(HLS_ROOT, id)

  fs.mkdirSync(output, {
    recursive: true
  })

  const playlist = path.join(
    output,
    'index.m3u8'
  )

  const headers = decodeHeaders(source)

  const ffmpegHeaders = buildFFmpegHeaders(headers)

  console.log(
    `[stream] headers recibidos=${Object.keys(headers).length}`
  )

  if (ffmpegHeaders) {
    console.log(
      `[stream] usando headers=${Object.keys(headers).join(', ')}`
    )
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',

    '-reconnect',
    '1',

    '-reconnect_streamed',
    '1',

    '-reconnect_delay_max',
    '5'
  ]

  if (ffmpegHeaders) {
    args.push(
      '-headers',
      ffmpegHeaders
    )
  }

  args.push(
    '-i',
    source.toString(),

    '-map',
    '0:v:0?',

    '-map',
    '0:a:0?',

    '-c',
    'copy',

    '-f',
    'hls',

    '-hls_time',
    '2',

    '-hls_list_size',
    '6',

    '-hls_flags',
    'delete_segments+append_list+omit_endlist',

    '-hls_segment_filename',
    path.join(
      output,
      'segment-%06d.ts'
    ),

    playlist
  )

  console.log(
    `[stream] ffmpeg iniciado id=${id}`
  )

  const child = spawn(
    process.env.FFMPEG_PATH || 'ffmpeg',
    args,
    {
      stdio: [
        'ignore',
        'ignore',
        'pipe'
      ]
    }
  )

  const session = {
    id,
    source: source.toString(),
    output,
    process: child,
    timer: null
  }

  sessions.set(id, session)

  touch(session)

  child.stderr.on('data', data => {
    const message = data
      .toString()
      .trim()

    if (message) {
      console.error(
        `[ffmpeg:${id}] ${message}`
      )
    }
  })

  child.on('error', error => {
    console.error(
      `[ffmpeg:${id}] error de proceso: ${error.message}`
    )
  })

  child.on('exit', (code, signal) => {
    if (sessions.has(id)) {
      console.log(
        `[stream] ffmpeg terminó id=${id} code=${code} signal=${signal}`
      )

      cleanup(id)
    }
  })

  await new Promise(resolve =>
    setTimeout(resolve, 3000)
  )

  if (!fs.existsSync(playlist)) {
    if (child.exitCode !== null) {
      throw new Error(
        'FFmpeg no pudo abrir el stream. Revisá los logs de FFmpeg.'
      )
    }

    console.log(
      `[stream] esperando playlist id=${id}`
    )
  }

  return session
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok'
  })
})

app.get('/stream', async (req, res) => {
  try {
    const rawUrl = req.query.url

    if (
      typeof rawUrl !== 'string' ||
      !rawUrl.trim()
    ) {
      return res.status(400).json({
        error: 'Falta el parámetro url'
      })
    }

    const source = await validateSource(
      rawUrl
    )

    const session = await startSession(
      source
    )

    touch(session)

    res.json({
      id: session.id,
      playlist:
        `/hls/${session.id}/index.m3u8`,
      url:
        `https://${req.get('host')}/hls/${session.id}/index.m3u8`
    })
  } catch (error) {
    console.error(
      `[stream] error: ${error.message}`
    )

    res.status(400).json({
      error: error.message
    })
  }
})

app.use(
  '/hls',
  express.static(HLS_ROOT, {
    fallthrough: false,
    maxAge: 0
  })
)

app.get('/', (_req, res) => {
  res.json({
    service: 'MPD to HLS relay',
    status: 'ok',
    endpoints: {
      health: '/health',
      stream: '/stream?url=MPD_URL'
    }
  })
})

app.listen(PORT, () => {
  console.log(
    `[stream] servidor escuchando en ${PORT}`
  )
})

process.on('SIGTERM', () => {
  for (const id of sessions.keys()) {
    cleanup(id)
  }

  process.exit(0)
})

process.on('SIGINT', () => {
  for (const id of sessions.keys()) {
    cleanup(id)
  }

  process.exit(0)
})
