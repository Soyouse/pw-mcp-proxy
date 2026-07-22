// PUR : DÉCISION de rotation du log (isolée de l'I/O, appliquée par logger.js).
// Rotation par TAILLE (built-to-last : le fichier de log NE DOIT JAMAIS croître sans borne =
// fuite disque silencieuse). Zéro dépendance, zéro état ici : entrées -> décision déterministe.
// Mutation-testée (Stryker) comme tout module pur du repo.

// Faut-il roter AVANT d'écrire cette ligne ? maxBytes<=0 => rotation DÉSACTIVÉE (borne infinie
// assumée). Sinon on rote dès que la ligne ferait dépasser le plafond de la génération courante.
export function shouldRotate(currentBytes, lineBytes, maxBytes) {
  return maxBytes > 0 && currentBytes + lineBytes > maxBytes;
}

// Séquence de renames pour libérer `file` en conservant `maxFiles` générations
// (file, file.1, …, file.(maxFiles-1)). ⚠️ ORDRE DÉCROISSANT OBLIGATOIRE : on déplace la
// génération la PLUS ANCIENNE en premier => aucune génération n'est écrasée avant d'avoir été
// elle-même déplacée (invariant scellé par property-test). L'I/O (logger.js) applique chaque
// [from,to] par unlink(to)+rename(from,to) (⚠️ Windows: renameSync échoue si `to` existe).
// maxFiles<=1 => aucune archive => plan vide (l'appelant TRONQUE le fichier courant).
export function rotationPlan(file, maxFiles) {
  // maxFiles<=1 => la boucle ne produit AUCUN rename (plan vide) : l'appelant tronque le fichier
  // courant. Pas de garde séparée (elle ferait double emploi avec la borne de boucle = mutant équivalent).
  const plan = [];
  for (let i = maxFiles - 1; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`;
    const to = `${file}.${i}`;
    plan.push([from, to]);
  }
  return plan;
}
