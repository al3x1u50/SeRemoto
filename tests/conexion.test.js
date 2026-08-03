// ============================================================
// conexion.test.js — Tests del servidor Relay
// ============================================================
// Tests automatizados usando node:test (Node 18+).
// Verifica: conexión, salas, retransmisión, rechazo y limpieza.
// ============================================================

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { httpServer, wss, salaManager } = require('../src/server');

// ─── Configuración del servidor de test ─────────────────────
const TEST_PORT = 3901;
const WS_URL = `ws://localhost:${TEST_PORT}`;

/**
 * Crea un cliente WebSocket envuelto con una cola de mensajes.
 * Esto evita perder mensajes que llegan antes de llamar a esperarMensaje.
 * @returns {Promise<{ws: WebSocket, esperarMensaje: Function, cerrar: Function}>}
 */
function crearCliente() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const colaMensajes = [];
    const esperando = [];

    ws.on('message', (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        parsed = data.toString();
      }

      // Si hay alguien esperando un mensaje, entregarlo directamente
      if (esperando.length > 0) {
        const { resolve: res } = esperando.shift();
        res(parsed);
      } else {
        // Si no, encolarlo para consumo futuro
        colaMensajes.push(parsed);
      }
    });

    /**
     * Espera el siguiente mensaje. Si ya hay uno en la cola, lo retorna inmediatamente.
     * @param {number} timeout - Timeout en ms.
     * @returns {Promise<object>}
     */
    function esperarMensaje(timeout = 3000) {
      // Si ya hay mensajes encolados, retornar el primero
      if (colaMensajes.length > 0) {
        return Promise.resolve(colaMensajes.shift());
      }

      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          // Remover de la cola de espera
          const idx = esperando.findIndex((e) => e.resolve === res);
          if (idx >= 0) esperando.splice(idx, 1);
          rej(new Error(`Timeout esperando mensaje (${timeout}ms)`));
        }, timeout);

        esperando.push({
          resolve: (msg) => {
            clearTimeout(timer);
            res(msg);
          },
        });
      });
    }

    /**
     * Cierra el WebSocket limpiamente.
     */
    function cerrar() {
      return new Promise((res) => {
        if (ws.readyState === WebSocket.CLOSED) {
          res();
          return;
        }
        ws.on('close', res);
        ws.close();
      });
    }

    ws.on('open', () => resolve({ ws, esperarMensaje, cerrar }));
    ws.on('error', reject);
  });
}

/**
 * Pequeña pausa para permitir procesamiento asíncrono.
 */
function pausa(ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Suite de Tests ─────────────────────────────────────────

describe('Servidor Relay WebSocket', () => {
  before(async () => {
    await new Promise((resolve) => {
      httpServer.listen(TEST_PORT, '127.0.0.1', resolve);
    });
    console.log(`[Test] Servidor de test iniciado en puerto ${TEST_PORT}`);
  });

  after(async () => {
    salaManager.detener();
    wss.clients.forEach((ws) => ws.terminate());
    await new Promise((resolve) => httpServer.close(resolve));
    console.log('[Test] Servidor de test cerrado');
  });

  // ─── Test 1: Conexión exitosa ───────────────────────────────
  describe('Conexión básica', () => {
    it('debe aceptar una conexión WebSocket', async () => {
      const cliente = await crearCliente();
      assert.equal(cliente.ws.readyState, WebSocket.OPEN);
      await cliente.cerrar();
    });

    it('debe responder al health check HTTP', async () => {
      const resp = await fetch(`http://localhost:${TEST_PORT}/health`);
      assert.equal(resp.status, 200);
      const body = await resp.json();
      assert.equal(body.status, 'ok');
      assert.equal(typeof body.salasActivas, 'number');
      assert.equal(typeof body.clientesConectados, 'number');
    });

    it('debe retornar 404 para rutas desconocidas', async () => {
      const resp = await fetch(`http://localhost:${TEST_PORT}/ruta-invalida`);
      assert.equal(resp.status, 404);
    });
  });

  // ─── Test 2: Crear sala y unirse con PIN ────────────────────
  describe('Gestión de salas', () => {
    it('debe permitir que un IDE cree y se una a una sala', async () => {
      const ide = await crearCliente();
      const pin = '123456';

      ide.ws.send(JSON.stringify({ type: 'join', pin, rol: 'ide' }));

      const resp = await ide.esperarMensaje();
      assert.equal(resp.type, 'notification');
      assert.equal(resp.evento, 'unido_a_sala');
      assert.equal(resp.pin, pin);
      assert.equal(resp.rol, 'ide');
      assert.equal(resp.peerConectado, false);

      await ide.cerrar();
    });

    it('debe permitir que un móvil se una a una sala existente', async () => {
      const pin = '654321';

      // IDE se une primero
      const ide = await crearCliente();
      ide.ws.send(JSON.stringify({ type: 'join', pin, rol: 'ide' }));
      await ide.esperarMensaje(); // notificación: unido_a_sala

      // Móvil se une después
      const movil = await crearCliente();
      movil.ws.send(JSON.stringify({ type: 'join', pin, rol: 'movil' }));

      // El móvil recibe confirmación
      const respMovil = await movil.esperarMensaje();
      assert.equal(respMovil.evento, 'unido_a_sala');
      assert.equal(respMovil.peerConectado, true);

      // El IDE recibe notificación de peer conectado
      const respIde = await ide.esperarMensaje();
      assert.equal(respIde.evento, 'peer_conectado');
      assert.equal(respIde.rol, 'movil');

      await ide.cerrar();
      await movil.cerrar();
    });
  });

  // ─── Test 3: Retransmisión de mensajes cifrados ─────────────
  describe('Retransmisión E2E', () => {
    it('debe retransmitir un mensaje cifrado del IDE al móvil', async () => {
      const pin = '111111';

      // Ambos se unen
      const ide = await crearCliente();
      const movil = await crearCliente();

      ide.ws.send(JSON.stringify({ type: 'join', pin, rol: 'ide' }));
      await ide.esperarMensaje(); // unido_a_sala

      movil.ws.send(JSON.stringify({ type: 'join', pin, rol: 'movil' }));
      await movil.esperarMensaje(); // unido_a_sala
      await ide.esperarMensaje();   // peer_conectado

      // IDE envía mensaje cifrado
      const payloadCifrado = {
        encryptedData: 'SGVsbG8gV29ybGQ=',
        iv: 'dGVzdGl2MTIzNDU2',
        tag: 'dGFnZGVhdXRoMTIz',
      };

      ide.ws.send(JSON.stringify({
        type: 'message',
        pin,
        payload: payloadCifrado,
      }));

      // El móvil debe recibir el mensaje retransmitido
      const mensajeRecibido = await movil.esperarMensaje();
      assert.equal(mensajeRecibido.type, 'message');
      assert.equal(mensajeRecibido.pin, pin);
      assert.equal(mensajeRecibido.rolOrigen, 'ide');
      assert.deepEqual(mensajeRecibido.payload, payloadCifrado);

      await ide.cerrar();
      await movil.cerrar();
    });

    it('debe retransmitir un mensaje cifrado del móvil al IDE', async () => {
      const pin = '222222';

      const ide = await crearCliente();
      const movil = await crearCliente();

      ide.ws.send(JSON.stringify({ type: 'join', pin, rol: 'ide' }));
      await ide.esperarMensaje(); // unido_a_sala

      movil.ws.send(JSON.stringify({ type: 'join', pin, rol: 'movil' }));
      await movil.esperarMensaje(); // unido_a_sala
      await ide.esperarMensaje();   // peer_conectado

      // Móvil envía prompt cifrado al IDE
      const payloadPrompt = {
        encryptedData: 'cHJvbXB0Q2lmcmFkbw==',
        iv: 'aXZkZXByb21wdA==',
      };

      movil.ws.send(JSON.stringify({
        type: 'message',
        pin,
        payload: payloadPrompt,
      }));

      const mensajeRecibido = await ide.esperarMensaje();
      assert.equal(mensajeRecibido.type, 'message');
      assert.equal(mensajeRecibido.rolOrigen, 'movil');
      assert.deepEqual(mensajeRecibido.payload, payloadPrompt);

      await ide.cerrar();
      await movil.cerrar();
    });
  });

  // ─── Test 4: Rechazo de tercer cliente ──────────────────────
  describe('Límite de clientes', () => {
    it('debe rechazar un segundo cliente con el mismo rol', async () => {
      const pin = '333333';

      // Primer IDE se une
      const ide1 = await crearCliente();
      ide1.ws.send(JSON.stringify({ type: 'join', pin, rol: 'ide' }));
      await ide1.esperarMensaje(); // unido_a_sala

      // Segundo IDE intenta unirse
      const ide2 = await crearCliente();
      ide2.ws.send(JSON.stringify({ type: 'join', pin, rol: 'ide' }));

      const resp = await ide2.esperarMensaje();
      assert.equal(resp.type, 'error');
      assert.equal(resp.codigo, 'SALA_LLENA');

      await ide1.cerrar();
      await ide2.cerrar();
    });
  });

  // ─── Test 5: Limpieza al desconectar ────────────────────────
  describe('Limpieza de conexiones', () => {
    it('debe notificar al peer cuando el otro se desconecta', async () => {
      const pin = '444444';

      const ide = await crearCliente();
      const movil = await crearCliente();

      ide.ws.send(JSON.stringify({ type: 'join', pin, rol: 'ide' }));
      await ide.esperarMensaje(); // unido_a_sala

      movil.ws.send(JSON.stringify({ type: 'join', pin, rol: 'movil' }));
      await movil.esperarMensaje(); // unido_a_sala
      await ide.esperarMensaje();   // peer_conectado

      // El móvil se desconecta
      await movil.cerrar();

      // El IDE debe recibir notificación de desconexión
      const notif = await ide.esperarMensaje();
      assert.equal(notif.type, 'notification');
      assert.equal(notif.evento, 'peer_desconectado');
      assert.equal(notif.rol, 'movil');

      await ide.cerrar();
    });

    it('debe eliminar la sala cuando ambos peers se desconectan', async () => {
      const pin = '555555';

      const ide = await crearCliente();
      const movil = await crearCliente();

      ide.ws.send(JSON.stringify({ type: 'join', pin, rol: 'ide' }));
      await ide.esperarMensaje(); // unido_a_sala

      movil.ws.send(JSON.stringify({ type: 'join', pin, rol: 'movil' }));
      await movil.esperarMensaje(); // unido_a_sala
      await ide.esperarMensaje();   // peer_conectado

      // Ambos se desconectan
      await ide.cerrar();
      await movil.cerrar();
      await pausa(200);

      // Verificar que la sala ya no existe
      assert.equal(salaManager.salas.has(pin), false);
    });
  });

  // ─── Test 6: Validación de mensajes inválidos ───────────────
  describe('Validación de mensajes', () => {
    it('debe rechazar JSON inválido', async () => {
      const cliente = await crearCliente();
      cliente.ws.send('esto no es json {{{');

      const resp = await cliente.esperarMensaje();
      assert.equal(resp.type, 'error');
      assert.equal(resp.codigo, 'MENSAJE_INVALIDO');

      await cliente.cerrar();
    });

    it('debe rechazar tipo de mensaje desconocido', async () => {
      const cliente = await crearCliente();
      cliente.ws.send(JSON.stringify({ type: 'tipo_inventado' }));

      const resp = await cliente.esperarMensaje();
      assert.equal(resp.type, 'error');
      assert.equal(resp.codigo, 'MENSAJE_INVALIDO');

      await cliente.cerrar();
    });

    it('debe rechazar join sin PIN válido', async () => {
      const cliente = await crearCliente();
      cliente.ws.send(JSON.stringify({ type: 'join', pin: 'abc', rol: 'ide' }));

      const resp = await cliente.esperarMensaje();
      assert.equal(resp.type, 'error');
      assert.equal(resp.codigo, 'MENSAJE_INVALIDO');

      await cliente.cerrar();
    });

    it('debe responder pong a un ping', async () => {
      const cliente = await crearCliente();
      cliente.ws.send(JSON.stringify({ type: 'ping' }));

      const resp = await cliente.esperarMensaje();
      assert.equal(resp.type, 'pong');
      assert.equal(typeof resp.timestamp, 'number');

      await cliente.cerrar();
    });
  });
});
