// Gate couplage-par-IMPORT — no-circular = ERROR (cliquet, zéro cycle toléré à la baseline).
// ⚠️ NE JAMAIS passer no-circular en warn : un cycle nouveau DOIT être rouge en CI.
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules|reports|coverage|build|dist|\.stryker-tmp" },
  },
};
