// ============================================================
// protocolo.js — Esquema y validación de mensajes del Relay
// ============================================================
// Define los tipos de mensajes permitidos y valida su estructura
// antes de procesarlos en el servidor.
// ============================================================

'use strict';

/**
 * Tipos de mensaje válidos en el protocolo.
 * - join:    El cliente solicita unirse a una sala por PIN.
 * - message: Envío de un payload cifrado al otro peer.
 * - leave:   El cliente abandona la sala voluntariamente.
 * - ping:    Latido de vida (cliente → servidor).
 * - pong:    Respuesta de latido (servidor → cliente).
 */
const TIPOS_MENSAJE = Object.freeze({
  JOIN: 'join',
  MESSAGE: 'message',
  LEAVE: 'leave',
  PING: 'ping',
  PONG: 'pong',
});

/**
 * Tipos de rol que puede tener un cliente en la sala.
 */
const ROLES = Object.freeze({
  IDE: 'ide',
  MOVIL: 'movil',
});

/**
 * Códigos de error del protocolo.
 */
const CODIGOS_ERROR = Object.freeze({
  MENSAJE_INVALIDO: 'MENSAJE_INVALIDO',
  SALA_LLENA: 'SALA_LLENA',
  SALA_NO_ENCONTRADA: 'SALA_NO_ENCONTRADA',
  PIN_INVALIDO: 'PIN_INVALIDO',
  PAYLOAD_INVALIDO: 'PAYLOAD_INVALIDO',
  ERROR_INTERNO: 'ERROR_INTERNO',
});

/**
 * Valida que un PIN tenga el formato correcto (6 dígitos numéricos).
 * @param {string} pin - El PIN a validar.
 * @returns {boolean} true si el PIN es válido.
 */
function validarPin(pin) {
  return typeof pin === 'string' && /^\d{6}$/.test(pin);
}

/**
 * Valida la estructura básica de un mensaje entrante.
 * No valida el contenido cifrado (eso lo hace crypto-utils).
 *
 * @param {object} mensaje - El mensaje parseado.
 * @returns {{ valido: boolean, error?: string }}
 */
function validarMensaje(mensaje) {
  // Debe ser un objeto
  if (!mensaje || typeof mensaje !== 'object') {
    return { valido: false, error: 'El mensaje debe ser un objeto JSON válido' };
  }

  // Tipo de mensaje requerido
  const tiposValidos = Object.values(TIPOS_MENSAJE);
  if (!tiposValidos.includes(mensaje.type)) {
    return {
      valido: false,
      error: `Tipo de mensaje inválido: "${mensaje.type}". Tipos válidos: ${tiposValidos.join(', ')}`,
    };
  }

  // Validaciones específicas por tipo
  switch (mensaje.type) {
    case TIPOS_MENSAJE.JOIN:
      return validarMensajeJoin(mensaje);
    case TIPOS_MENSAJE.MESSAGE:
      return validarMensajeMessage(mensaje);
    case TIPOS_MENSAJE.LEAVE:
    case TIPOS_MENSAJE.PING:
    case TIPOS_MENSAJE.PONG:
      // Estos tipos no requieren campos adicionales obligatorios
      return { valido: true };
    default:
      return { valido: false, error: 'Tipo de mensaje no manejado' };
  }
}

/**
 * Valida un mensaje de tipo "join".
 * Requiere: pin (6 dígitos) y rol (ide | movil).
 */
function validarMensajeJoin(mensaje) {
  if (!validarPin(mensaje.pin)) {
    return { valido: false, error: 'El PIN debe ser una cadena de 6 dígitos numéricos' };
  }

  const rolesValidos = Object.values(ROLES);
  if (!rolesValidos.includes(mensaje.rol)) {
    return {
      valido: false,
      error: `Rol inválido: "${mensaje.rol}". Roles válidos: ${rolesValidos.join(', ')}`,
    };
  }

  return { valido: true };
}

/**
 * Valida un mensaje de tipo "message".
 * Requiere: pin y payload con datos cifrados.
 */
function validarMensajeMessage(mensaje) {
  if (!validarPin(mensaje.pin)) {
    return { valido: false, error: 'El PIN debe ser una cadena de 6 dígitos numéricos' };
  }

  if (!mensaje.payload || typeof mensaje.payload !== 'object') {
    return { valido: false, error: 'El campo "payload" es requerido y debe ser un objeto' };
  }

  // Validar que el payload tenga los campos cifrados requeridos
  const camposRequeridos = ['encryptedData', 'iv'];
  for (const campo of camposRequeridos) {
    if (typeof mensaje.payload[campo] !== 'string' || mensaje.payload[campo].length === 0) {
      return {
        valido: false,
        error: `El campo "payload.${campo}" es requerido y debe ser un string no vacío`,
      };
    }
  }

  return { valido: true };
}

/**
 * Construye un mensaje de error para enviar al cliente.
 * @param {string} codigo - Código de error (de CODIGOS_ERROR).
 * @param {string} detalle - Descripción legible del error.
 * @returns {string} Mensaje JSON serializado.
 */
function construirError(codigo, detalle) {
  return JSON.stringify({
    type: 'error',
    codigo,
    detalle,
    timestamp: Date.now(),
  });
}

/**
 * Construye un mensaje de notificación del servidor.
 * @param {string} evento - Nombre del evento (ej: 'peer_conectado', 'peer_desconectado').
 * @param {object} datos - Datos adicionales del evento.
 * @returns {string} Mensaje JSON serializado.
 */
function construirNotificacion(evento, datos = {}) {
  return JSON.stringify({
    type: 'notification',
    evento,
    ...datos,
    timestamp: Date.now(),
  });
}

module.exports = {
  TIPOS_MENSAJE,
  ROLES,
  CODIGOS_ERROR,
  validarPin,
  validarMensaje,
  construirError,
  construirNotificacion,
};
