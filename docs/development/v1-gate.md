# Gate V1 headless local

Ce gate qualifie le parcours opérateur Kurobara sans interface et sans prompt.
Il ne publie rien, ne pousse aucun commit et ne transforme pas une qualification
locale en approbation juridique ou en release OSS publique.

## Profils

Le profil `fixture` est le contrôle par défaut. Il n'ouvre aucun fichier de
credentials, ne démarre aucun provider et n'effectue aucun appel réseau
provider. Il vérifie Node/npm, l'état Git, les hashes et références des exemples,
le `--check` du bundle planning, une preuve de fallback contrôlée,
Ultracite/architecture, typecheck, tests et build. Cette preuve sans réseau
compose le registre maintenu par Kurobara, les adapters Tavily et Exa et le bridge plugin :
le transport simulé renvoie un `429` Tavily certain et retryable, puis un succès
Exa avec la même clé d'opération. Elle ne démarre ni worker, ni PostgreSQL et ne
prouve donc ni le routage persistant du runtime, ni un fallback live. Son
outcome est volontairement `fixture-dry-run-passed` : ce n'est pas une preuve
clone-vers-résultat.

```sh
node scripts/v1-gate.mjs --mode fixture \
  --report /tmp/kurobara-v1-fixture-report.json
```

Le profil `live` ajoute une qualification locale isolée de PostgreSQL et
Hatchet, puis le vertical complet. Il :

> **Gate contractuel actuel :** ce profil Exa est une preuve historique et ne
> doit pas être relancé sous les conditions standard relues le 23 juillet 2026.
> La [policy BYOK](../policies/byok-provider-terms.md) exige des Additional
> Terms ou un accord écrit couvrant ce cas d'usage avant tout nouvel appel Exa.
> `--confirm-provider-calls` est un contrôle de dépense, pas une preuve de
> droits.

1. crée un projet Compose unique sur des ports loopback temporaires ;
2. applique le bundle planning et crée une clé API éphémère ;
3. démarre l'API avec les routes Tavily puis Exa ;
4. importe et rejoue le dataset par la CLI ;
5. crée et annule un run encore en file, puis rejoue la même clé d'idempotence,
   si `runs.cancel@1.0.0` est déclaré ;
6. effectue un probe Exa borné sur `example.com`, puis démarre le worker ;
7. applique/rejoue la recette et attend une cellule réussie ;
8. relit PostgreSQL et exige exactement deux tentatives Tavily -> Exa, la même
   `operation_key`, les raisons `initial` puis `fallback`, les deux seuils
   d'effet, le règlement exact d'une requête par tentative et les décisions de
   routage correspondantes ;
9. exporte en JSONL, redémarre API et worker, rejoue et compare le hash exact du
   second export ;
10. arrête les processus et supprime le projet Compose isolé avec ses volumes.

Ce profil exerce l'annulation avant claim. La convergence d'un run actif est
qualifiée séparément par les tests application : `SettleCancellation` n'est
accepté qu'après fermeture durable de toutes les tentatives et réservations ;
un effet préparé, réclamé, en vol ou ambigu maintient le run en `cancelling`.

Le vertical et le probe Exa consomment au plus trois requêtes provider : une
tentative Tavily, une tentative Exa de fallback et le probe Exa séparé. Le
profil live n'accepte donc pas un simple succès final : son readback durable
doit prouver le fallback exact et sa comptabilité. La preuve fixture reste le
scénario déterministe de la même règle sans réseau. Un résultat ambigu arrête au
contraire le parcours sans retry ni fallback. Le flag explicite protège contre
une dépense accidentelle :

```sh
node scripts/v1-gate.mjs --mode live \
  --provider-env-file /absolute/path/to/private-provider.env \
  --confirm-provider-calls \
  --require-clean \
  --report /tmp/kurobara-v1-live-report.json
```

Le fichier provider doit être régulier, non symlink, de mode `0600` (ou plus
strict), d'au plus 64 Kio et contenir des littéraux non quotés :

```dotenv
TAVILY_API_KEY=replace-with-local-secret
EXA_API_KEY=replace-with-local-secret
KUROBARA_EXA_DATA_RIGHTS_CONFIRMED=true
```

Le parseur ignore les noms hors allowlist et ne source jamais le fichier dans
un shell. La valeur `true` atteste seulement que l'opérateur a obtenu et
conservé les termes écrits requis par la policy ; le flag ne les prouve pas et
ne doit pas être positionné sous les conditions standard relues. Les clés
provider restent dans la mémoire des processus enfants. La
clé Kurobara éphémère transite par un fichier temporaire `0600`, jamais par un
argument CLI. Le rapport conserve uniquement versions, compteurs, raisons,
hashes et résultat normalisé ; ni réponse provider brute, ni référence externe,
ni token, DSN ou credential n'est écrit. Les compteurs provider distinguent la
borne autorisée, la borne supérieure des appels potentiellement engagés et les
appels confirmés par probe ou readback PostgreSQL. Un échec après le
franchissement d'un call site reste ainsi compté de façon conservative au lieu
d'afficher zéro.

`--keep-infrastructure` conserve volontairement le projet isolé et inscrit son
`command_argv` de nettoyage exact dans le rapport. Sans ce flag, le cleanup est
automatique, y compris après échec. Si Docker refuse ce cleanup, le gate échoue,
conserve le répertoire d'état et publie le même `command_argv` pour une reprise
explicite. Le gate refuse d'écraser un rapport ou un export existant.

## Qualification d'un coding agent

Le gate et les cinq commandes Kurobara sont non interactifs : stdin est fermé,
les sorties sont un JSON unique et les secrets utilisent des fichiers privés.
Un agent n'a donc pas besoin d'inventer un protocole, de lire `.env.local` ou de
copier une clé dans son prompt. Depuis un clone frais, donnez-lui uniquement la
commande exacte :

```sh
codex exec --sandbox workspace-write \
  "Exécute sans modifier les fichiers: node scripts/v1-gate.mjs --mode fixture --require-clean --report /tmp/kurobara-codex-v1.json. Retourne le code de sortie et l'outcome JSON."
```

```sh
claude -p --output-format json \
  "Exécute sans modifier les fichiers: node scripts/v1-gate.mjs --mode fixture --require-clean --report /tmp/kurobara-claude-v1.json. Retourne le code de sortie et l'outcome JSON."
```

La première commande constitue la preuve V1 observée. La seconde est une
recette de compatibilité optionnelle : le contrat Kurobara ne dépend d'aucun de
ces outils et la gate n'exige pas leur qualification simultanée.

La qualification live doit rester une décision opérateur : l'agent reçoit le
chemin du fichier privé et le flag `--confirm-provider-calls`, jamais ses valeurs.
Lors de la qualification locale du 20 juillet 2026, Codex CLI `0.144.4` a
exécuté cette fixture jusqu'à `fixture-dry-run-passed` dans son sandbox
workspace-write et le clone est resté propre. Claude Code `2.1.81` a été lancé
avec la commande ci-dessus, mais le compte local a répondu
`Credit balance is too low` avant tout token, outil ou lancement du gate. Cette
preuve qualifie donc le parcours Codex, pas le parcours Claude ; ce dernier
reste `non qualifié` dans la matrice sans bloquer le candidat local. Un succès
prouve seulement que le parcours Kurobara appelé ne demande ni TTY, ni saisie
humaine, ni secret en argument ; il ne certifie pas le comportement général de
l'agent.

## Clone frais

Le clone reste une étape externe pour éviter qu'un gate local choisisse ou
publie un remote. La preuve du candidat local se lance depuis un clone sans objets locaux,
avec le runtime épinglé et un rapport hors du dépôt :

```sh
git clone --no-local "$KUROBARA_CANDIDATE_URL" kurobara-v1-candidate
cd kurobara-v1-candidate
npm ci
node scripts/v1-gate.mjs --mode fixture --require-clean \
  --report /tmp/kurobara-v1-candidate-fixture.json
```

Puis seulement, si les conditions provider et la dépense sont approuvées,
exécutez le profil live. Cette procédure a été rejouée avec succès sur un clone
`--no-local` propre lors de la qualification du 20 juillet 2026, y compris le
profil live et la fixture pilotée par Codex. Claude reste une compatibilité
optionnelle non qualifiée pour la raison documentée plus haut. Un succès local
ne prouve pas l'accès anonyme au remote, les règles GitHub, la provenance, les
licences, les artifacts de release, la disponibilité publique des packages ou
l'accord des providers pour une distribution OSS. Ces gates restent séparés et
doivent être relus sur le commit candidat exact.
