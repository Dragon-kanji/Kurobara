# Gate de preview publique anonyme

- Statut : **outil local disponible — aucune preuve publique enregistrée**
- Ticket : `KRB-PUB-007`
- Effets externes attendus : clone et téléchargements HTTPS

`scripts/public-preview-gate.sh` est l'unique entrée de production. Il vérifie
deux fois le même candidat dans **deux conteneurs Docker distincts**, puis
détruit chaque conteneur. Le worker
`scripts/public-preview-gate.mjs` refuse une invocation de production directe.
Le gate ne pousse aucun ref, ne crée ni tag ni release, ne change pas la
visibilité GitHub et son parcours fixture n'appelle aucun provider.

La cible `Dragon-kanji/Kurobara` étant privée et vide lors de la création de ce
gate, l'outil est actuellement **inutilisable comme preuve publique**. Un clone
anonyme réel ne peut réussir qu'après l'approbation `PUBLIC-001` et la bascule
contrôlée de visibilité. Un succès obtenu depuis un remote local ou avec une
identité GitHub ne clôt pas `KRB-PUB-007`.

## Contrat fail-closed

Le launcher exige :

- Docker et l'image immuable
  `node:24.14.0-bookworm@sha256:5a593d74b632d1c6f816457477b6819760e13624455d587eef0fa418c8d0777b` ;
- la plateforme qualifiée `linux/amd64`, y compris sous émulation sur un hôte
  Apple Silicon ;
- une URL de dépôt HTTPS sans credential, query ou fragment ;
- le SHA complet du commit attendu et le tag exact qui doit pointer vers lui ;
- une URL HTTPS de manifest d'artifacts ;
- le SHA-256 attendu de ce manifest, fourni par une surface de preuve séparée ;
- exactement deux passes ;
- un répertoire absolu qui n'existe pas encore pour les rapports.

Chaque pass s'exécute dans un conteneur créé avec :

1. la racine en lecture seule, un `tmpfs` neuf `exec,nosuid,nodev` pour `/tmp`
   afin d'exécuter les shims audités de `node_modules/.bin`,
   `no-new-privileges` et `--cap-drop ALL` ;
2. un vérificateur `uid=0,gid=0` qui ne conserve que `SETUID` et `SETGID`.
   Ces deux capabilities servent exclusivement à lancer les commandes Git,
   npm et fixture candidates en `uid=1000,gid=1000` ; leur effective set est
   vérifié vide avant le clone ;
3. un environnement reconstruit par `env -i` : aucun `HOME`, credential,
   proxy, configuration TLS, npm ou option Node de l'hôte n'est transmis ;
4. uniquement le worker comme montage bind dans la première pass. Chaque
   conteneur reçoit sous `/root` son propre volume Docker anonyme de sortie,
   possédé par root, en mode `0700`, jamais partagé et supprimé avec lui. Un
   second volume anonyme root-owned, non inscriptible par le candidat, porte
   uniquement le wrapper npm exécutable. Le candidat ne peut ni lire ni écrire
   le volume de rapports, y compris depuis un processus laissé en arrière-plan.
   La seconde pass reçoit en plus `pass-1.json`, monté en lecture seule ;
5. un clone `--no-local`, sans tags ni checkout implicite, créé dans le
   `tmpfs` du conteneur ;
6. la récupération du seul tag attendu, la vérification de son commit puis le
   checkout du SHA exact en detached HEAD ;
7. un nouveau téléchargement du manifest et de chaque artifact, avec limites
   de taille et vérification de la taille et du SHA-256 ;
8. un wrapper npm root-owned dans son volume anonyme qui exécute
   `corepack npm` depuis le clone dont le manifest doit épingler `npm@10.9.4`,
   puis
   `npm ci --ignore-scripts` ;
9. la recréation du `HOME` candidat dédié, par le même UID, afin que les
   métadonnées écrites par npm, Corepack ou l'émulation ne deviennent pas un
   état implicite du gate. Le processus qualifié n'accepte ensuite que le
   répertoire `.cache/rosetta` recréé au démarrage par l'émulateur, ou un
   `HOME` vide sur un hôte natif ;
10. uniquement le profil sûr
   `scripts/v1-gate.mjs --mode fixture --require-clean`.

Le launcher utilise `docker create`, puis `docker start --attach`. Il copie les
rapports avec `docker cp` seulement après l'arrêt du conteneur, avant de le
détruire. Le code candidat n'observe donc jamais un montage hôte inscriptible.
Le vérificateur écrit seul le rapport final dans le volume root-only après la
fin de la commande candidate.
La seconde pass valide strictement le JSON de la première avant d'écrire le
résumé. Aucun clone, cache, `HOME`, volume ou autre état n'est partagé entre
les deux conteneurs.

Le conteneur conserve cependant un accès sortant ordinaire sur le réseau bridge
pour Git, Corepack/npm et les artifacts. Ce gate n'est donc pas une sandbox
d'egress contre un commit candidat malveillant. Sa qualification repose sur le
SHA exact préalablement audité, l'absence de credentials transmise et le profil
fixture ; elle ne prouve pas qu'un code arbitraire serait incapable d'émettre
une autre requête réseau.

Le profil fixture ne démarre aucun provider et ne lit aucun fichier de
credentials. Il reste distinct du profil live historique Tavily → Exa, qui
n'est jamais exécuté par cette commande.

Le manifest JSON est strict :

```json
{
  "format_version": "1.0.0",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "tag": "v0.1.0-rc.4",
  "artifacts": [
    {
      "name": "kurobara-v0.1.0-rc.4-source.tar.gz",
      "url": "https://github.com/Dragon-kanji/Kurobara/releases/download/v0.1.0-rc.4/kurobara-v0.1.0-rc.4-source.tar.gz",
      "size_bytes": 123456,
      "sha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

Les champs inconnus, noms dupliqués, chemins d'artifacts, URL non HTTPS, tailles
non bornées, hash ou version inattendus font échouer la pass.

Cet `artifacts-manifest.json` est une surface de publication distincte :
`release:candidate` produit un `release-manifest.json` local lié au commit et à
l'arbre, mais il ne peut pas inventer le futur tag ni les URLs HTTPS. Le
manifest public doit être généré depuis les artifacts effectivement uploadés,
puis son propre hash doit être publié par une surface de preuve séparée.

## Exécution publique

La commande suivante ne devient légitime qu'après :

- reconstruction et qualification du candidat clean-room final ;
- production des artifacts, SBOMs, notices, checksums et attestations exacts ;
- activation et readback des contrôles GitHub requis ;
- approbation humaine datée de `PUBLIC-001` ;
- publication contrôlée du commit, du tag et des artifacts correspondants.

```sh
bash scripts/public-preview-gate.sh \
  --repository-url https://github.com/Dragon-kanji/Kurobara.git \
  --expected-commit 0123456789abcdef0123456789abcdef01234567 \
  --expected-tag v0.1.0-rc.4 \
  --artifacts-manifest-url https://github.com/Dragon-kanji/Kurobara/releases/download/v0.1.0-rc.4/artifacts-manifest.json \
  --expected-artifacts-manifest-sha256 sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --passes 2 \
  --report-dir /absolute/new/path/kurobara-public-preview
```

Le manifest doit contenir le même commit et le même tag. Les deux conteneurs
retéléchargent leurs entrées ; ils ne partagent ni clone, ni cache, ni rapport
fixture. Les sorties attendues sont :

```text
kurobara-public-preview/
├── pass-1.json
├── pass-2.json
└── summary.json
```

Le répertoire est refusé s'il existe déjà. Si la première pass échoue, seul son
rapport est copié et la seconde n'est pas démarrée. Si la seconde pass démarre,
elle produit aussi le résumé, y compris en cas d'échec. Les rapports d'échec ne
contiennent que le code d'erreur, jamais la sortie Git, les variables
d'environnement, les URLs redirigées ou les chemins temporaires.

## Fixture de test locale

Les tests automatisés utilisent un dépôt bare et des artifacts `file://` avec
`--allow-local-test-remote`. Ce flag est refusé sauf lorsque le harness
positionne simultanément :

```dotenv
NODE_ENV=test
KUROBARA_PUBLIC_PREVIEW_TESTING=true
```

Ce mode est exécuté en processus uniquement par le harness Node et porte
explicitement `mode: local-test`,
`isolation_contract.boundary: in-process-test-harness` et
`public_proof: false` dans les rapports. Il démontre le comportement du
vérificateur — deux passes, suppression des credentials et refus des dérives —
mais ne prouve ni l'isolation Docker, ni l'accès anonyme, la disponibilité
publique, la signature de release, la publication npm/OCI ou les droits de
publication.

Les tests unitaires utilisent également un faux client Docker pour vérifier la
construction des deux conteneurs, leurs options de confinement, les montages
en lecture seule et le refus de l'entrée Node directe. Ce test de construction
ne constitue pas non plus une preuve d'exécution publique.

## Portée de la preuve

Une exécution réussie prouve seulement que :

- le remote HTTPS était lisible sans credential au moment des deux passes ;
- le tag observé pointait vers le commit demandé ;
- le manifest et les artifacts téléchargés correspondaient aux hashes fournis ;
- le profil fixture du dépôt passait deux fois depuis deux conteneurs propres,
  distincts et éphémères, avec les contraintes d'isolation rapportées.

Elle ne signe pas le tag, ne valide pas l'autorité du titulaire, n'approuve pas
les notices tierces, les marques ou les conditions providers, et ne remplace pas la
vérification des signatures, SBOMs, provenance, packages et images demandée par
`RELEASE-001`, `PUBLIC-001` et `LAUNCH-001`.
