// ============================================================
// crypto-utils.js — Utilidades de validación de formato cifrado
// ============================================================
// El servidor Relay NUNCA descifra los mensajes. Este módulo
// solo valida que los datos cifrados tengan el formato correcto
// (base64 válido) y genera PINes aleatorios de 6 dígitos.
// ============================================================

'use strict';

const crypto = require('node:crypto');

/**
 * Expresión regular para validar strings en formato Base64.
 * Acepta Base64 estándar con padding opcional.
 */
const REGEX_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Valida que un string sea Base64 válido y no esté vacío.
 * @param {string} valor - El string a validar.
 * @returns {boolean} true si es Base64 válido.
 */
function esBase64Valido(valor) {
  if (typeof valor !== 'string' || valor.length === 0) {
    return false;
  }
  return REGEX_BASE64.test(valor);
}

/**
 * Valida la estructura de un payload cifrado.
 * Verifica que contenga los campos necesarios en formato Base64:
 * - encryptedData: Los datos cifrados
 * - iv: Vector de inicialización (16 bytes para AES-CBC → 24 chars en base64)
 * - tag (opcional): No usado en CBC, reservado para futura migración a GCM
 *
 * @param {object} payload - El objeto payload a validar.
 * @returns {{ valido: boolean, error?: string }}
 */
function validarPayloadCifrado(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valido: false, error: 'El payload debe ser un objeto' };
  }

  // Validar encryptedData
  if (!esBase64Valido(payload.encryptedData)) {
    return {
      valido: false,
      error: '"encryptedData" debe ser un string Base64 válido y no vacío',
    };
  }

  // Validar iv (vector de inicialización)
  if (!esBase64Valido(payload.iv)) {
    return {
      valido: false,
      error: '"iv" debe ser un string Base64 válido y no vacío',
    };
  }

  // Validar tag si está presente (opcional; reservado para futura migración a GCM)
  if (payload.tag !== undefined) {
    if (!esBase64Valido(payload.tag)) {
      return {
        valido: false,
        error: '"tag" debe ser un string Base64 válido si se proporciona',
      };
    }
  }

  return { valido: true };
}

/**
 * Genera un PIN aleatorio de 6 dígitos numéricos.
 * Usa crypto.randomInt para seguridad criptográfica.
 *
 * @returns {string} PIN de 6 dígitos (ej: "048372").
 */
function generarPin() {
  // randomInt genera un entero entre 0 (inclusive) y 1_000_000 (exclusive)
  const numero = crypto.randomInt(0, 1_000_000);
  return numero.toString().padStart(6, '0');
}

/**
 * Genera un ID de sesión único usando UUID v4.
 * Se usa internamente; el paquete uuid se importa en server.js.
 *
 * @returns {string} ID de sesión basado en timestamp + random.
 */
function generarSessionId() {
  // Fallback simple sin dependencia de uuid para este módulo
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = {
  esBase64Valido,
  validarPayloadCifrado,
  generarPin,
  generarSessionId,
};
