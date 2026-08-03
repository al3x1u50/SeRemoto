#!/usr/bin/env node

// ============================================================
// index.js — Punto de entrada principal para despliegue
// ============================================================
// Este archivo sirve como punto de entrada para servicios como Render
// que buscan ejecutar "node index.js" por defecto.
// ============================================================

'use strict';

// Redirigir al servidor principal
require('./src/server.js');