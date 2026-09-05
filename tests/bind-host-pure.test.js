// PUR + property — la DÉCISION « où les serveurs ont le droit d'écouter ». Cible Stryker : src/bind-host-pure.js
//
// ENJEU : `@playwright/mcp` n'a AUCUNE authentification. Un `bindHost` accepté à tort = un navigateur
// connecté (cookies, comptes) offert au réseau. Chaque refus nomme SA cause ; chaque admission a sa classe.

import { test, expect } from 'vitest';
import fc from 'fast-check';
import { classeAdresse, verdictBindHost } from '../src/bind-host-pure.js';

const IFACES = {
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1' }],
  ctxroute: [{ address: '10.87.87.1' }],
  'Wi-Fi': [{ address: '192.168.1.185' }],
  Tailscale: [{ address: '100.119.218.99' }],
};

test('classeAdresse : loopback, lien-local, privé, routable, invalide', () => {
  expect(classeAdresse('localhost')).toBe('loopback');
  expect(classeAdresse('::1')).toBe('loopback');
  expect(classeAdresse('127.0.0.1')).toBe('loopback');
  expect(classeAdresse('127.255.255.254')).toBe('loopback');
  expect(classeAdresse('169.254.29.100')).toBe('lien-local');
  expect(classeAdresse('10.87.87.1')).toBe('prive');
  expect(classeAdresse('172.16.0.1')).toBe('prive');
  expect(classeAdresse('172.31.255.255')).toBe('prive');
  expect(classeAdresse('172.32.0.1')).toBe('routable');
  expect(classeAdresse('192.168.1.185')).toBe('prive');
  expect(classeAdresse('100.119.218.99'), 'Tailscale (100.64/10) est ROUTABLE sur le maillage').toBe('routable');
  expect(classeAdresse('8.8.8.8')).toBe('routable');
  for (const x of ['', '256.1.1.1', '1.2.3', 'abc', '::2', null, 42]) expect(classeAdresse(x), String(x)).toBe(null);
});

test('absent/vide ⇒ loopback par défaut (le produit OSS marche partout sans carte)', () => {
  expect(verdictBindHost(undefined)).toEqual({ ok: true, classe: 'loopback' });
  expect(verdictBindHost(null)).toEqual({ ok: true, classe: 'loopback' });
  expect(verdictBindHost('')).toEqual({ ok: true, classe: 'loopback' });
  expect(verdictBindHost('localhost')).toEqual({ ok: true, classe: 'loopback' });
  expect(verdictBindHost('127.0.0.1')).toEqual({ ok: true, classe: 'loopback' });
});

test('lien-local (169.254/16) admis SANS déclaration : jamais routé par construction', () => {
  expect(verdictBindHost('169.254.29.100')).toEqual({ ok: true, classe: 'lien-local' });
});

test('ROUTABLE (public, Tailscale) ⇒ REFUSÉ et nommé, quelle que soit la carte déclarée', () => {
  for (const h of ['8.8.8.8', '100.119.218.99', '172.32.0.1']) {
    const r = verdictBindHost(h, { interfaceDeclaree: 'Tailscale', interfaces: IFACES });
    expect(r.ok, h).toBe(false);
    expect(r.raison).toMatch(/ROUTABLE/);
    expect(r.raison).toMatch(/aucune authentification/);
  }
});

test('PRIVÉ : admis UNIQUEMENT avec la carte déclarée ET l adresse mesurée dessus', () => {
  expect(verdictBindHost('10.87.87.1', { interfaceDeclaree: 'ctxroute', interfaces: IFACES })).toEqual({ ok: true, classe: 'isole' });
  const sansCarte = verdictBindHost('10.87.87.1', { interfaces: IFACES });
  expect(sansCarte.ok).toBe(false);
  expect(sansCarte.raison).toMatch(/bindHostInterface/);
  const carteInconnue = verdictBindHost('10.87.87.1', { interfaceDeclaree: 'fantome', interfaces: IFACES });
  expect(carteInconnue.ok).toBe(false);
  expect(carteInconnue.raison).toMatch(/aucune carte de ce nom/);
  const mauvaiseCarte = verdictBindHost('10.87.87.1', { interfaceDeclaree: 'Wi-Fi', interfaces: IFACES });
  expect(mauvaiseCarte.ok).toBe(false);
  expect(mauvaiseCarte.raison).toMatch(/n'est PAS une adresse de la carte "Wi-Fi"/);
  const lan = verdictBindHost('192.168.1.185', { interfaceDeclaree: 'Wi-Fi', interfaces: IFACES });
  expect(lan.ok, 'le Wi-Fi est un vrai LAN : la config le PERMET si déclaré — la responsabilité est nommée, pas cachée').toBe(true);
});

test('types absurdes ⇒ refus nommé, jamais un throw', () => {
  for (const x of [42, true, {}, []]) {
    const r = verdictBindHost(x);
    expect(r.ok, String(x)).toBe(false);
    expect(r.raison).toMatch(/chaîne/);
  }
  const r = verdictBindHost('pas-une-ip');
  expect(r.ok).toBe(false);
  expect(r.raison).toMatch(/ni localhost, ni une adresse IPv4/);
});

test('PROPERTY totalité : aucune entrée ne fait throw, et un ok porte toujours une classe', () => {
  fc.assert(
    fc.property(fc.anything(), fc.anything(), (h, ctx) => {
      const r = verdictBindHost(h, ctx && typeof ctx === 'object' ? ctx : {});
      return typeof r.ok === 'boolean' && (r.ok ? typeof r.classe === 'string' : typeof r.raison === 'string');
    }),
    { numRuns: 400 }
  );
});

test('PROPERTY sécurité : une adresse ROUTABLE n est JAMAIS admise, quelles que soient carte et interfaces', () => {
  const octet = fc.integer({ min: 0, max: 255 });
  fc.assert(
    fc.property(octet, octet, octet, octet, fc.string(), (a, b, c, d, carte) => {
      const h = `${a}.${b}.${c}.${d}`;
      if (classeAdresse(h) !== 'routable') return true;
      return verdictBindHost(h, { interfaceDeclaree: carte, interfaces: { [carte]: [{ address: h }] } }).ok === false;
    }),
    { numRuns: 500 }
  );
});
