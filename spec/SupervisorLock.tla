---------------------------- MODULE SupervisorLock ----------------------------
(***************************************************************************)
(* Spec TLA+ du VERROU FICHIER inter-process de supervisor.js (_lock).      *)
(*                                                                          *)
(* Pourquoi : plusieurs proxys (= agents Claude) se serialisent via un      *)
(* lockfile `openSync(wx)` + VOL du verrou perime (LOCK_STALE_MS). La       *)
(* doctrine impose : « locks distribues -> TLA+ + trace validation ». Cette *)
(* spec modelise le protocole a la granularite des pas atomiques reels du   *)
(* filesystem (openSync wx / stat / unlink) pour exposer la course de vol.  *)
(*                                                                          *)
(* Invariant central : MutualExclusion = au plus UN proxy en section        *)
(* critique (ensureServer). Le violer = double spawn @playwright/mcp =       *)
(* « browser is already in use » (le bug P0 que tout le projet combat).      *)
(*                                                                          *)
(* CONSTANT Fixed bascule les DEUX protocoles dans la meme spec :           *)
(*   Fixed = FALSE -> vol par unlink INCONDITIONNEL (code actuel, BUGGE).   *)
(*   Fixed = TRUE  -> vol SERIALISE par meta-verrou + re-verif peremption.   *)
(* Config buggy (negative-check) : TLC DOIT trouver un contre-exemple.       *)
(* Config fixed : TLC DOIT prouver l'exclusion (aucune violation).           *)
(*                                                                          *)
(* Primitives modelisees = SEULEMENT celles atomiques garanties par Node    *)
(* cross-OS : openSync('wx') (create-fail-if-exists), unlink, stat(mtime).   *)
(* renameSync est ECARTE a dessein (overwrite POSIX vs throw Windows =       *)
(* pas d'atomicite « fail-if-exists » portable). Cf commentaire du fix.      *)
(***************************************************************************)
EXTENDS FiniteSets, Naturals

CONSTANTS Procs, Fixed, NoOwner  (* NoOwner = valeur modele (lockfile absent) *)

VARIABLES
  lock,       (* Procs \cup {NoOwner} : proprietaire du lockfile, ou absent  *)
  fresh,      (* BOOLEAN : mtime du lockfile courant est-il frais (vs perime) *)
  meta,       (* Procs \cup {NoOwner} : meta-verrou du vol (mode Fixed only)  *)
  pc,         (* [Procs -> pas du protocole]                                 *)
  obsStale    (* [Procs -> BOOLEAN] : snapshot de peremption vu en "check"    *)

vars == <<lock, fresh, meta, pc, obsStale>>

States == {"idle","try","check","steal","steal_do","cs","dead"}

TypeOK ==
  /\ lock \in Procs \cup {NoOwner}
  /\ fresh \in BOOLEAN
  /\ meta \in Procs \cup {NoOwner}
  /\ pc \in [Procs -> States]
  /\ obsStale \in [Procs -> BOOLEAN]

Init ==
  /\ lock = NoOwner
  /\ fresh = TRUE
  /\ meta = NoOwner
  /\ pc = [p \in Procs |-> "idle"]
  /\ obsStale = [p \in Procs |-> FALSE]

(* Un proxy idle tente d'acquerir : passe a "try".                          *)
Begin(p) ==
  /\ pc[p] = "idle"
  /\ pc' = [pc EXCEPT ![p] = "try"]
  /\ UNCHANGED <<lock, fresh, meta, obsStale>>

(* openSync(path,'wx') : ATOMIQUE. Absent -> je cree (frais) et j'entre en   *)
(* section critique. Present -> EEXIST -> je vais lire le mtime ("check").    *)
Open(p) ==
  /\ pc[p] = "try"
  /\ IF lock = NoOwner
       THEN /\ lock' = p
            /\ fresh' = TRUE
            /\ pc' = [pc EXCEPT ![p] = "cs"]
            /\ UNCHANGED <<meta, obsStale>>
       ELSE /\ pc' = [pc EXCEPT ![p] = "check"]
            /\ UNCHANGED <<lock, fresh, meta, obsStale>>

(* statSync : je LIS le mtime (snapshot). Perime -> je vais voler ("steal"). *)
(* Frais -> j'attends (retour "try"). Le snapshot obsStale est la source du   *)
(* bug : il peut etre invalide au moment ou j'agis reellement (TOCTOU).       *)
Check(p) ==
  /\ pc[p] = "check"
  /\ lock # NoOwner
  /\ obsStale' = [obsStale EXCEPT ![p] = ~fresh]
  /\ pc' = [pc EXCEPT ![p] = IF ~fresh THEN "steal" ELSE "try"]
  /\ UNCHANGED <<lock, fresh, meta>>
(* Le verrou a disparu entre open et stat : on reboucle sur "try".           *)
CheckVanished(p) ==
  /\ pc[p] = "check"
  /\ lock = NoOwner
  /\ pc' = [pc EXCEPT ![p] = "try"]
  /\ UNCHANGED <<lock, fresh, meta, obsStale>>

(* ---- MODE BUGGE (Fixed=FALSE) : vol par unlink INCONDITIONNEL ----        *)
(* Reproduit `_lock` actuel : sur snapshot perime -> unlinkSync sans re-check.*)
(* Supprime AVEUGLEMENT le verrou courant, meme s'il a ete remplace par un    *)
(* verrou FRAIS d'un autre proxy entre-temps => exclusion cassee.             *)
StealBuggy(p) ==
  /\ ~Fixed
  /\ pc[p] = "steal"
  /\ lock' = NoOwner
  /\ pc' = [pc EXCEPT ![p] = "try"]
  /\ UNCHANGED <<fresh, meta, obsStale>>

(* ---- MODE CORRIGE (Fixed=TRUE) : vol SERIALISE par meta-verrou ----        *)
(* On acquiert d'abord un meta-verrou (openSync wx sur un 2e fichier) : un     *)
(* SEUL voleur a la fois. Sous ce meta-verrou on RE-STAT le lockfile : comme   *)
(* un verrou frais ne peut naitre (Open) que si le path est absent, tant que   *)
(* le perime est la aucun frais ne peut apparaitre -> l'unlink re-verifie ne   *)
(* peut JAMAIS supprimer un verrou frais.                                     *)
StealAcquireMeta(p) ==
  /\ Fixed
  /\ pc[p] = "steal"
  /\ meta = NoOwner
  /\ meta' = p
  /\ pc' = [pc EXCEPT ![p] = "steal_do"]
  /\ UNCHANGED <<lock, fresh, obsStale>>
StealWaitMeta(p) ==       (* meta occupe : un autre vole -> je reboucle       *)
  /\ Fixed
  /\ pc[p] = "steal"
  /\ meta # NoOwner
  /\ pc' = [pc EXCEPT ![p] = "try"]
  /\ UNCHANGED <<lock, fresh, meta, obsStale>>
StealDo(p) ==
  /\ Fixed
  /\ pc[p] = "steal_do"
  /\ meta = p
  (* RE-VERIF sous meta-verrou : unlink UNIQUEMENT si toujours present ET perime *)
  /\ lock' = IF lock # NoOwner /\ ~fresh THEN NoOwner ELSE lock
  /\ meta' = NoOwner
  /\ pc' = [pc EXCEPT ![p] = "try"]
  /\ UNCHANGED <<fresh, obsStale>>

(* Fin normale de section critique : je relache le verrou (unlink de MON lock).*)
Release(p) ==
  /\ pc[p] = "cs"
  /\ lock = p
  /\ lock' = NoOwner
  /\ pc' = [pc EXCEPT ![p] = "idle"]
  /\ UNCHANGED <<fresh, meta, obsStale>>

(* CRASH en section critique : le proxy meurt en TENANT le verrou. Le lockfile *)
(* reste (lock=p) mais son mtime va se perimer (fresh:=FALSE) => c'est ce que   *)
(* les autres devront voler. Le proc mort ne rejoue jamais (etat "dead").       *)
Crash(p) ==
  /\ pc[p] = "cs"
  /\ pc' = [pc EXCEPT ![p] = "dead"]
  /\ fresh' = FALSE
  /\ UNCHANGED <<lock, meta, obsStale>>

Next ==
  \E p \in Procs :
    \/ Begin(p) \/ Open(p) \/ Check(p) \/ CheckVanished(p)
    \/ StealBuggy(p)
    \/ StealAcquireMeta(p) \/ StealWaitMeta(p) \/ StealDo(p)
    \/ Release(p) \/ Crash(p)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* INVARIANT DE SURETE : au plus un proxy en section critique.             *)
(***************************************************************************)
InCS == {p \in Procs : pc[p] = "cs"}
MutualExclusion == Cardinality(InCS) <= 1

=============================================================================
