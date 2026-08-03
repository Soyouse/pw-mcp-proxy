// PUR — SOURCE UNIQUE de la version de protocole MCP que le proxy SUPPOSE quand personne ne la lui dit.
//
// ⚠️ RAISON D'ETRE (trouvee a l'audit du 03/08/2026) : ce littéral existait en TROIS exemplaires
// indépendants — `PROTOCOL_FALLBACK` dans `router.js`, `DEFAULT_CLIENT_INFO.protocolVersion` dans
// `manager.js`, et le paramètre par défaut de `HttpTransport`. Aucun outil ne le voyait : `jscpd`
// cherche des BLOCS dupliqués, pas un littéral isolé répété dans trois fichiers différents.
// Le jour d'un bump de la spec MCP, en corriger deux sur trois donnerait un proxy qui annonce une
// version au client et une AUTRE au backend — une incohérence de handshake, donc muette et tordue.
//
// 🛑 NE JAMAIS re-ecrire cette chaine ailleurs dans `src/`. Scelle par `no-hardcoded-protocol-gate`.
//
// ⚠️ CE N'EST PAS « la version que le proxy parle ». Le proxy est un PASSTHROUGH : il relaie la
// version NEGOCIEE par Claude (`clientInfo.protocolVersion`) et n'impose jamais la sienne. Cette
// constante ne sert QUE de repli quand le client n'a rien annonce — cas hors-spec, mais un client
// exotique ne doit pas faire tomber le proxy pour autant.
export const PROTOCOL_FALLBACK = '2025-06-18';
