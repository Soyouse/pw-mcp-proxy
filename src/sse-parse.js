// sse-parse.js — DECODAGE PUR d'un flux Server-Sent Events (aucune I/O) => testable + mutable.
// Le transport HTTP (http-transport.js) fait le fetch/stream ; ICI, uniquement le FRAMING :
// « ces octets accumules donnent quels events SSE, et que reste-t-il en attente ». Isole du reseau
// pour passer au crible Stryker (doctrine : la decision hors I/O). Ref format = skill playwright-mcp-api
// (transport Streamable HTTP MCP) + SSE standard WHATWG.
//
// ⚠️ INVARIANT SCELLE (property-test) : le DECOUPAGE du flux en chunks arbitraires ne change JAMAIS
// la suite d'events extraits. C'est le piege classique du parsing SSE incremental (un event a cheval
// sur deux chunks). On accumule `pending` AVANT de parser => un CRLF coupe est recolle.

// Un event SSE est termine par une LIGNE VIDE. Champs pertinents (MCP) : data (concatene par \n),
// event, id, retry. Ligne commencant par ':' = commentaire (ignore). CRLF supporte ; CR-seul
// (vieux Mac) NON (hors chemin : les serveurs MCP emettent \n) => traite comme data ordinaire.

// Parse UN bloc (texte entre deux lignes vides). Retourne l'event, ou null si bloc sans aucun champ.
export function parseSseBlock(block) {
  const lines = String(block ?? '').split('\n');
  let event = null;
  let id = null;
  let retry = null;
  const data = [];
  let sawData = false;
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue; // ligne vide interne ou commentaire
    const c = line.indexOf(':');
    let field;
    let value;
    if (c === -1) {
      field = line; // champ sans valeur (spec : valeur = "")
      value = '';
    } else {
      field = line.slice(0, c);
      value = line.slice(c + 1);
      if (value.startsWith(' ')) value = value.slice(1); // un seul espace de tete retire (spec)
    }
    switch (field) {
      case 'data': data.push(value); sawData = true; break;
      case 'event': event = value; break;
      case 'id': id = value; break;
      case 'retry': retry = value; break;
      default: break; // champ inconnu : ignore (spec SSE)
    }
  }
  if (!sawData && event === null && id === null && retry === null) return null;
  return { event: event ?? 'message', data: data.join('\n'), id, retry };
}

// Accumulateur incremental PUR. `pending` = fragment non termine du feed precedent ('' au depart).
// Retourne { pending, events } : events complets extraits, pending = reste a completer.
// Ne throw JAMAIS (total). Idempotent sur le CRLF (re-normaliser un buffer deja normalise ne change rien).
export function sseFeed(pending, chunk) {
  let buf = (pending ?? '') + (chunk ?? '');
  buf = buf.replace(/\r\n/g, '\n'); // CRLF -> LF (le CR d'un CRLF a cheval est deja recolle a son LF ici)
  const events = [];
  let idx;
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const ev = parseSseBlock(block);
    if (ev) events.push(ev);
  }
  return { pending: buf, events };
}
