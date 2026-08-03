// ============================================================
// server.js — Servidor Relay WebSocket principal
// ============================================================
// Servidor HTTP + WebSocket que retransmite mensajes cifrados
// entre un IDE y una app móvil dentro de salas por PIN.
// No almacena ni descifra ningún dato.
// ============================================================

'use strict';

const http = require('node:http');
const { WebSocketServer } = require('ws');
const { TIPOS_MENSAJE, CODIGOS_ERROR, validarMensaje, construirError, construirNotificacion } = require('./protocolo');
const { SalaManager } = require('./sala-manager');

// ─── Configuración ──────────────────────────────────────────
const PUERTO = parseInt(process.env.PORT, 10) || 3900;
const HOST = process.env.HOST || '0.0.0.0';

// ─── Instancias ─────────────────────────────────────────────
const salaManager = new SalaManager();

// ─── Servidor HTTP (para health check) ──────────────────────
const httpServer = http.createServer((req, res) => {
  // Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    const stats = salaManager.obtenerEstadisticas();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      ...stats,
      timestamp: Date.now(),
    }));
    return;
  }

  // Cualquier otra ruta → 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'No encontrado' }));
});

// ─── Servidor WebSocket ─────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[Relay] Nueva conexión desde ${ip}`);

  // Configurar timeout de inactividad por conexión individual (5 min sin mensajes)
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // ─── Manejo de mensajes ───────────────────────────────────
  ws.on('message', (data) => {
    let mensaje;

    // Intentar parsear el JSON
    try {
      mensaje = JSON.parse(data.toString());
    } catch {
      ws.send(construirError(
        CODIGOS_ERROR.MENSAJE_INVALIDO,
        'El mensaje no es un JSON válido'
      ));
      return;
    }

    // Validar estructura del mensaje
    const validacion = validarMensaje(mensaje);
    if (!validacion.valido) {
      ws.send(construirError(CODIGOS_ERROR.MENSAJE_INVALIDO, validacion.error));
      return;
    }

    // Procesar según tipo
    procesarMensaje(ws, mensaje);
  });

  // ─── Desconexión ──────────────────────────────────────────
  ws.on('close', (code, reason) => {
    console.log(`[Relay] Conexión cerrada (código: ${code})`);
    salaManager.desconectar(ws);
  });

  ws.on('error', (error) => {
    console.error(`[Relay] Error en conexión:`, error.message);
    salaManager.desconectar(ws);
  });
});

// ─── Procesamiento de mensajes ──────────────────────────────

/**
 * Procesa un mensaje validado según su tipo.
 * @param {object} ws - Conexión WebSocket del remitente.
 * @param {object} mensaje - Mensaje parseado y validado.
 */
function procesarMensaje(ws, mensaje) {
  switch (mensaje.type) {
    case TIPOS_MENSAJE.JOIN:
      manejarJoin(ws, mensaje);
      break;

    case TIPOS_MENSAJE.MESSAGE:
      manejarMessage(ws, mensaje);
      break;

    case TIPOS_MENSAJE.LEAVE:
      manejarLeave(ws);
      break;

    case TIPOS_MENSAJE.PING:
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;

    default:
      ws.send(construirError(
        CODIGOS_ERROR.MENSAJE_INVALIDO,
        `Tipo de mensaje no soportado: ${mensaje.type}`
      ));
  }
}

/**
 * Maneja la solicitud de unirse a una sala.
 */
function manejarJoin(ws, mensaje) {
  const { pin, rol } = mensaje;
  const resultado = salaManager.unirseASala(pin, rol, ws);

  if (!resultado.exito) {
    ws.send(construirError(CODIGOS_ERROR.SALA_LLENA, resultado.error));
  }
}

/**
 * Maneja la retransmisión de un mensaje cifrado.
 */
function manejarMessage(ws, mensaje) {
  const { pin, payload } = mensaje;
  const resultado = salaManager.retransmitir(pin, ws, payload);

  if (!resultado.exito) {
    ws.send(construirError(CODIGOS_ERROR.PAYLOAD_INVALIDO, resultado.error));
  }
}

/**
 * Maneja la desconexión voluntaria de un cliente.
 */
function manejarLeave(ws) {
  salaManager.desconectar(ws);
  ws.send(construirNotificacion('desconectado', { motivo: 'Desconexión voluntaria' }));
}

// ─── Heartbeat: Detectar conexiones muertas ─────────────────
const INTERVALO_HEARTBEAT_MS = 30_000;

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[Relay] Terminando conexión sin respuesta a heartbeat');
      salaManager.desconectar(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, INTERVALO_HEARTBEAT_MS);

wss.on('close', () => {
  clearInterval(heartbeat);
  salaManager.detener();
});

// ─── Iniciar servidor ───────────────────────────────────────
function iniciar() {
  httpServer.listen(PUERTO, HOST, () => {
    console.log('═══════════════════════════════════════════════');
    console.log('  🔌 Agent Remote Relay — Servidor iniciado');
    console.log(`  📡 WebSocket:  ws://${HOST}:${PUERTO}`);
    console.log(`  🏥 Health:     http://${HOST}:${PUERTO}/health`);
    console.log('═══════════════════════════════════════════════');
  });
}

// Solo iniciar si se ejecuta directamente (no cuando se importa para tests)
if (require.main === module) {
  iniciar();
}

// Exportar para tests
module.exports = { httpServer, wss, salaManager, iniciar };
