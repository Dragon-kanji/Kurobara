# Quickstart self-host local

Ce guide démarre le candidat V1 OSS en local et prouve une recette synthétique
complète sans provider, crédit, compte Kurobara ou LLM. Il ne configure pas un
service Internet : l'API est publiée uniquement sur `127.0.0.1`, Hatchet reste
interne au réseau Compose et son image auth-disabled est réservée à ce profil
local.

## Prérequis

- Git ;
- Docker avec Compose v2 ;
- Node.js `24.14.0` et npm `10.9.4` pour les commandes depuis les sources.

Depuis un clone propre :

```sh
npm ci
npm run self-host:smoke
```

Le smoke construit les bundles et trois images locales, démarre PostgreSQL,
Hatchet, l'API et le worker, applique la planification synthétique, crée une clé
éphémère, importe le dataset d'exemple, exécute une recette, attend son état
`succeeded`, redémarre PostgreSQL, vérifie le même résultat durable, puis
effectue un dump/restore PostgreSQL et une seconde relecture. Il supprime
ensuite son projet Compose, ses volumes, sa clé et son dump de test. Aucun
provider n'est appelé.

## Démarrage manuel persistant

Créez une configuration privée et remplacez les deux valeurs d'exemple :

```sh
cp deploy/self-host/.env.example deploy/self-host/.env
chmod 600 deploy/self-host/.env
```

Puis démarrez la stack :

```sh
docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yaml \
  up --detach --build --wait
```

Les deux lectures locales suivantes doivent répondre :

```sh
curl --fail http://127.0.0.1:3000/healthz
curl --fail http://127.0.0.1:3000/readyz
```

Initialisez les snapshots de planification :

```sh
docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yaml \
  --profile tools run --rm bootstrap-planning
```

Créez ensuite la première clé API et capturez directement le JSON de bootstrap
sans afficher la clé :

```bash
(
  set -o pipefail
  umask 077
  api_key_file="${HOME}/.config/kurobara-api-key"
  api_key_directory="${api_key_file%/*}"
  install -d -m 700 "${api_key_directory}"
  if [[ -e "${api_key_file}" || -L "${api_key_file}" ]]; then
    echo "Refusing to overwrite existing API key file: ${api_key_file}" >&2
    exit 1
  fi
  temporary_key_file="$(
    mktemp "${api_key_directory}/.kurobara-api-key.XXXXXX"
  )"
  trap 'rm -f -- "${temporary_key_file}"' EXIT HUP INT TERM

  docker compose \
    --env-file deploy/self-host/.env \
    -f deploy/self-host/compose.yaml \
    --profile tools run --rm bootstrap-api-key |
    node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        input += chunk;
      });
      process.stdin.on("end", () => {
        const parsed = JSON.parse(input);
        if (
          typeof parsed.presented_key !== "string" ||
          parsed.presented_key.length < 32
        ) {
          throw new Error("Bootstrap response does not contain a valid key.");
        }
        process.stdout.write(`${parsed.presented_key}\n`);
      });
    ' >"${temporary_key_file}"
  chmod 600 "${temporary_key_file}"
  if ! ln "${temporary_key_file}" "${api_key_file}"; then
    echo "Refusing to overwrite existing API key file: ${api_key_file}" >&2
    exit 1
  fi
  rm -f -- "${temporary_key_file}"
  trap - EXIT HUP INT TERM
)
```

Le nom de fichier final est créé atomiquement et l'opération échoue si la
destination existe déjà.
La clé n'entre ni dans les arguments des processus ni dans la sortie du
terminal. Ne committez jamais ce fichier.

Utilisez ensuite la CLI source avec `--api-key-file`, par exemple :

```sh
npm run kurobara -- dataset import \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file "${HOME}/.config/kurobara-api-key" \
  --metadata examples/dataset-import/metadata.json \
  --source examples/dataset-import/source.jsonl

npm run kurobara -- recipe apply \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file "${HOME}/.config/kurobara-api-key" \
  --request examples/recipe-apply/request.example.json

npm run kurobara -- recipe watch \
  --endpoint http://127.0.0.1:3000 \
  --api-key-file "${HOME}/.config/kurobara-api-key" \
  --application-id application_demo_org_website_v1 \
  --timeout-ms 120000
```

Le résultat synthétique utilise `fixture.invalid`. Ce fichier Compose est
exclusivement un profil de qualification fixture : il fixe
`KUROBARA_FIXTURE_MODE=deterministic` pour l'API et
`KUROBARA_LEAF_EFFECT_ADAPTER=deterministic-local` pour le worker. Ajouter une
clé provider au fichier `.env` ou tenter de surcharger ces variables depuis le
shell ne transforme pas ce profil en runtime BYOK.

Un runtime provider réel exige une configuration Compose explicite et revue :
elle retire le mode fixture de l'API, sélectionne `configured-providers` pour le
worker, injecte seulement les credentials, attestations et paramètres de
confidentialité nécessaires, et borne les routes autorisées selon la
[policy providers](../policies/byok-provider-terms.md). Ce profil BYOK distinct
n'est pas qualifié par le présent quickstart sans réseau.

## Backup et restore

Le backup exige un répertoire absolu existant et crée un dump PostgreSQL privé :

```sh
deploy/self-host/backup.sh /absolute/path/to/backups
```

Le restore remplace explicitement la base applicative. Il arrête l'API et le
worker, restaure le dump exact dans une transaction unique avec arrêt au premier
diagnostic, puis redémarre les services uniquement après le commit réussi :

```sh
deploy/self-host/restore.sh \
  --confirm /absolute/path/to/backups/kurobara-YYYYMMDDTHHMMSSZ-XXXXXX.dump
```

Le suffixe aléatoire rend chaque nom de dump unique : deux backups lancés dans
la même seconde ne partagent ni fichier temporaire, ni destination finale.

Un fichier d'environnement situé ailleurs peut être sélectionné avec
`KUROBARA_SELF_HOST_ENV_FILE=/absolute/path/to/.env`.

Le smoke automatisé exécute réellement ces deux scripts contre sa base
éphémère. Il ne qualifie pas encore un restore entre versions, un stockage
objet ou une configuration de production distante.

## Candidat installable local

Depuis un worktree propre et committé :

```sh
npm run release:candidate -- --output /absolute/new/candidate-directory
```

Le répertoire contient les bundles autonomes sous `runtime/bin`, une archive
source, le tarball CLI, des SBOMs CycloneDX, `release-manifest.json` et
`SHA256SUMS`. La commande refuse un répertoire existant, une version Node/npm
différente ou un worktree suivi sale. Elle matérialise le commit exact dans un
espace temporaire, y réinstalle les dépendances depuis le lockfile avec
`npm ci --ignore-scripts`, puis construit sans lire les sources ou le
`node_modules` du worktree opérateur.

Vérifiez les hashes avant installation :

```sh
cd /absolute/new/candidate-directory
shasum --algorithm 256 --check SHA256SUMS
```

`release-manifest.json` lie aussi le candidat au commit, à l'arbre Git et à la
date source exacts. Il marque la reproductibilité byte-for-byte
`not-verified` : l'isolation et les hashes ne remplacent ni une seconde
construction identique, ni une attestation de provenance. C'est un manifest
local de build. Pour la source preview, `artifacts-manifest.json` du
[gate public](./public-preview-gate.md) ajoute le tag et les URLs HTTPS des
artifacts réellement publiés.

Le package CLI peut être installé hors ligne depuis le tarball produit :

```sh
npm install --global \
  /absolute/new/candidate-directory/npm/kurobara-cli-0.1.0-rc.4.tgz
kurobara --help
```

La source preview publie ces artifacts avec leurs checksums et SBOMs. Aucun
package npm, aucune image OCI ni compatibilité multi-architecture n'est annoncé.

## Arrêt

```sh
docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yaml \
  down
```

Cette commande conserve les volumes. Leur suppression est une opération
destructive volontaire et n'appartient pas au parcours d'arrêt normal.

## Troubleshooting

### Docker n'est pas disponible

`npm run self-host:smoke` échoue immédiatement si `docker info` ne répond pas.
Démarrez Docker Desktop ou le daemon Docker, puis vérifiez `docker compose
version` avant de relancer.

### Un port local est déjà occupé

Changez `KUROBARA_API_PORT` dans `deploy/self-host/.env`. Hatchet et les deux
bases PostgreSQL ne publient aucun port hôte dans ce profil.

### L'API ou le worker ne devient pas healthy

Inspectez uniquement les services applicatifs :

```sh
docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yaml \
  ps

docker compose \
  --env-file deploy/self-host/.env \
  -f deploy/self-host/compose.yaml \
  logs --tail 120 api worker
```

Ne publiez pas les logs Hatchet bruts : le profil auth-disabled peut y écrire
son token local. Vérifiez d'abord que les mots de passe d'exemple ont été
remplacés, que les volumes appartiennent au même projet Compose et que les
images épinglées sont disponibles pour l'architecture de la machine.

### Le worker refuse son token Hatchet

Le worker attend le fichier interne généré par Hatchet. Ne définissez pas
`HATCHET_CLIENT_TOKEN` dans le fichier `.env` et n'exposez pas Hatchet sur
Internet. Si le fichier n'apparaît pas, arrêtez la stack, inspectez l'état du
volume `hatchet-config` et recréez seulement une installation locale sans
données utiles.

### Le restore échoue

Le script exige un chemin absolu vers un fichier régulier non symlinké et une
stack utilisant exactement le même `COMPOSE_PROJECT_NAME`. Conservez le dump,
relisez la configuration sélectionnée par `KUROBARA_SELF_HOST_ENV_FILE` et ne
tentez pas un second restore destructif avant d'avoir compris le premier
diagnostic. L'API et le worker restent arrêtés après un échec ; relancez-les
uniquement après avoir vérifié l'état de PostgreSQL ou terminé un restore
correctif.
