// ============================================================
// sala-manager.js — Gestión de salas/rooms por PIN
// ============================================================
// Cada sala tiene un PIN de 6 dígitos y permite máximo 2 peers
// (1 IDE + 1 Móvil). El manager se encarga de crear, unir,
// retransmitir y limpiar salas.
// ============================================================

'use strict';

const { ROLES, CODIGOS_ERROR, construirError, construirNotificacion } = require('./protocolo');
const { validarPayloadCifrado } = require('./crypto-utils');

/**
 * Tiempo máximo de inactividad antes de limpiar una sala (30 min).
 */
const TIMEOUT_INACTIVIDAD_MS = 30 * 60 * 1000;

/**
 * Intervalo de revisión para limpieza de salas inactivas (5 min).
 */
const INTERVALO_LIMPIEZA_MS = 5 * 60 * 1000;

/**
 * Clase que gestiona todas las salas activas del servidor Relay.
 */
class SalaManager {
  constructor() {
    /**
     * Mapa de salas activas.
     * Clave: PIN (string de 6 dígitos)
     * Valor: { ide: WebSocket|null, movil: WebSocket|null, ultimaActividad: number }
     * @type {Map<string, {ide: object|null, movil: object|null, ultimaActividad: number}>}
     */
    this.salas = new Map();

    /**
     * Mapa inverso: WebSocket → { pin, rol }
     * Para buscar rápidamente la sala de un cliente al desconectarse.
     * @type {Map<object, {pin: string, rol: string}>}
     */
    this.clienteSala = new Map();

    // Iniciar limpieza periódica de salas inactivas
    this._intervalLimpieza = setInterval(() => {
      this.limpiarSalasInactivas();
    }, INTERVALO_LIMPIEZA_MS);
  }

  /**
   * Crea una nueva sala o la reutiliza si ya existe para el PIN dado.
   * Se invoca cuando un cliente con rol 'ide' envía un mensaje 'join'.
   *
   * @param {string} pin - PIN de 6 dígitos.
   * @returns {{ exito: boolean, error?: string }}
   */
  crearSala(pin) {
    if (this.salas.has(pin)) {
      // La sala ya existe, no es un error; el cliente se unirá
      return { exito: true };
    }

    this.salas.set(pin, {
      ide: null,
      movil: null,
      ultimaActividad: Date.now(),
    });

    console.log(`[SalaManager] Sala creada: ${pin}`);
    return { exito: true };
  }

  /**
   * Une un cliente WebSocket a una sala existente.
   *
   * @param {string} pin - PIN de la sala.
   * @param {string} rol - Rol del cliente ('ide' o 'movil').
   * @param {object} ws - Conexión WebSocket del cliente.
   * @returns {{ exito: boolean, error?: string }}
   */
  unirseASala(pin, rol, ws) {
    // Crear la sala si no existe (caso: el IDE crea la sala al unirse)
    if (!this.salas.has(pin)) {
      this.crearSala(pin);
    }

    const sala = this.salas.get(pin);

    // Verificar que el slot del rol esté disponible
    if (sala[rol] !== null) {
      return {
        exito: false,
        error: `Ya hay un cliente con rol "${rol}" en la sala ${pin}`,
      };
    }

    // Asignar el cliente al slot correspondiente
    sala[rol] = ws;
    sala.ultimaActividad = Date.now();

    // Registrar en el mapa inverso
    this.clienteSala.set(ws, { pin, rol });

    console.log(`[SalaManager] Cliente "${rol}" unido a sala ${pin}`);

    // Notificar al otro peer si está conectado
    const otroRol = rol === ROLES.IDE ? ROLES.MOVIL : ROLES.IDE;
    if (sala[otroRol]) {
      const notificacion = construirNotificacion('peer_conectado', { rol });
      sala[otroRol].send(notificacion);
    }

    // Confirmar al cliente que se unió exitosamente
    ws.send(construirNotificacion('unido_a_sala', {
      pin,
      rol,
      peerConectado: sala[otroRol] !== null,
    }));

    return { exito: true };
  }

  /**
   * Retransmite un mensaje cifrado al otro peer de la sala.
   * El servidor NO descifra el contenido, solo valida el formato.
   *
   * @param {string} pin - PIN de la sala.
   * @param {object} ws - WebSocket del remitente.
   * @param {object} payload - Payload cifrado { encryptedData, iv, tag? }.
   * @returns {{ exito: boolean, error?: string }}
   */
  retransmitir(pin, ws, payload) {
    const sala = this.salas.get(pin);
    if (!sala) {
      return { exito: false, error: `Sala ${pin} no encontrada` };
    }

    // Validar formato del payload cifrado (sin descifrarlo)
    const validacion = validarPayloadCifrado(payload);
    if (!validacion.valido) {
      return { exito: false, error: validacion.error };
    }

    // Identificar al otro peer
    const infoCLiente = this.clienteSala.get(ws);
    if (!infoCLiente) {
      return { exito: false, error: 'Cliente no registrado en ninguna sala' };
    }

    const otroRol = infoCLiente.rol === ROLES.IDE ? ROLES.MOVIL : ROLES.IDE;
    const otroPeer = sala[otroRol];

    if (!otroPeer) {
      return { exito: false, error: 'No hay otro peer conectado en la sala' };
    }

    // Actualizar timestamp de actividad
    sala.ultimaActividad = Date.now();

    // Retransmitir el mensaje tal cual (cifrado)
    const mensajeRetransmitido = JSON.stringify({
      type: 'message',
      pin,
      rolOrigen: infoCLiente.rol,
      payload,
      timestamp: Date.now(),
    });

    otroPeer.send(mensajeRetransmitido);

    return { exito: true };
  }

  /**
   * Desconecta un cliente y limpia su slot en la sala.
   * Notifica al otro peer si está conectado.
   *
   * @param {object} ws - WebSocket del cliente que se desconecta.
   */
  desconectar(ws) {
    const info = this.clienteSala.get(ws);
    if (!info) {
      return; // Cliente no estaba en ninguna sala
    }

    const { pin, rol } = info;
    const sala = this.salas.get(pin);

    if (sala) {
      // Limpiar el slot del cliente
      sala[rol] = null;

      console.log(`[SalaManager] Cliente "${rol}" desconectado de sala ${pin}`);

      // Notificar al otro peer
      const otroRol = rol === ROLES.IDE ? ROLES.MOVIL : ROLES.IDE;
      if (sala[otroRol]) {
        sala[otroRol].send(construirNotificacion('peer_desconectado', { rol }));
      }

      // Si la sala está vacía, eliminarla
      if (sala.ide === null && sala.movil === null) {
        this.salas.delete(pin);
        console.log(`[SalaManager] Sala ${pin} eliminada (vacía)`);
      }
    }

    // Limpiar mapa inverso
    this.clienteSala.delete(ws);
  }

  /**
   * Elimina salas que llevan más de TIMEOUT_INACTIVIDAD_MS sin actividad.
   * Se ejecuta periódicamente.
   */
  limpiarSalasInactivas() {
    const ahora = Date.now();
    let eliminadas = 0;

    for (const [pin, sala] of this.salas) {
      if (ahora - sala.ultimaActividad > TIMEOUT_INACTIVIDAD_MS) {
        // Notificar y cerrar conexiones activas
        for (const rol of [ROLES.IDE, ROLES.MOVIL]) {
          if (sala[rol]) {
            sala[rol].send(construirError(
              CODIGOS_ERROR.ERROR_INTERNO,
              'Sala cerrada por inactividad'
            ));
            sala[rol].close(1000, 'Inactividad');
            this.clienteSala.delete(sala[rol]);
          }
        }
        this.salas.delete(pin);
        eliminadas++;
      }
    }

    if (eliminadas > 0) {
      console.log(`[SalaManager] Limpieza: ${eliminadas} sala(s) inactiva(s) eliminada(s)`);
    }
  }

  /**
   * Obtiene estadísticas actuales del manager.
   * @returns {{ salasActivas: number, clientesConectados: number }}
   */
  obtenerEstadisticas() {
    return {
      salasActivas: this.salas.size,
      clientesConectados: this.clienteSala.size,
    };
  }

  /**
   * Detiene la limpieza periódica. Útil para tests.
   */
  detener() {
    if (this._intervalLimpieza) {
      clearInterval(this._intervalLimpieza);
      this._intervalLimpieza = null;
    }
  }
}

module.exports = { SalaManager, TIMEOUT_INACTIVIDAD_MS };
