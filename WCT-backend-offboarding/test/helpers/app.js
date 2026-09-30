'use strict';
require('./env');
const supertest = require('supertest');
const app = require('../../src/app');

module.exports = { request: () => supertest(app), app };
