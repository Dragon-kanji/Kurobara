# RFC-0010 — Lecture paginée des candidats entreprise

- Status: **Accepted**
- Author(s): Kurobara maintainers
- Decision owner: Leandre Desmaretz
- Implementation owner: Kurobara maintainers
- Created: 2026-07-22
- Supersedes: none
- Related ADRs: ADR-0005, ADR-0006, ADR-0007

## Summary

Kurobara ajoute l'opération publique additive
`organizations.candidates.list@1.0.0`. Elle lit, sans effet externe, une page
bornée de `CompanyCandidate` depuis une génération dont la matérialisation est
déjà `ready`.

La projection REST est
`GET /v1/dataset-generations/{generation_id}/company-candidates`, le SDK expose
`organizations.listCandidates` et la CLI non interactive expose
`company results`. MCP reste différé.

## Problem

Le suivi de génération expose l'état et les compteurs, mais pas les candidats
normalisés. Les clients ont besoin d'une lecture commune API, SDK et CLI qui ne
relance aucun provider et ne dépend d'aucun curseur privé.

## Decision

La requête exige `generation_id` et `limit`, borné de 1 à 100, et accepte
`after_ordinal`. Cette dernière valeur est un keyset Kurobara stable : la page
retourne les éléments dont l'ordinal immuable est strictement supérieur à ce
curseur. La réponse conserve `after_ordinal`, `limit`, `has_more` et un
`next_after_ordinal` nullable. Elle ne promet ni offset arbitraire ni ordre
provider.

La route ne retourne que le snapshot immuable d'une matérialisation `ready`.
Une génération absente, non visible dans le workspace ou non prête ne divulgue
aucun résultat partiel et utilise `dataset-generation-not-found`.

Chaque réponse porte les identités workspace, génération et dataset, le nombre
total de records, les candidats avec leur ordinal, ainsi qu'une provenance
vérifiable : capability et version, plan et query hashes, schema hash,
matérialisation, révision, content hash, date et raison de complétion, puis
coverage. La coverage reste soit `bounded`, soit
`complete_for_declared_source` sur la base `locked_provider_route`.
`caps-reached` accompagne une coverage bornée et `source-completed` une source
déclarée entièrement parcourue.

La surface publique ne contient aucun provider key, cursor, route, run,
attempt, receipt, cost ID, payload ou diagnostic. Ces éléments de lineage
restent internes et restreints.

## Public contracts and compatibility

Au moment de l'acceptation de cette RFC, l'opération, ses deux JSON Schema
`1.0.0`, OpenAPI, types TypeScript et descripteur CLI ont été générés depuis le
catalogue canonique `0.10.0`. L'ajout n'a
modifie ni ne supprime aucun membre `0.9.0` ; les consommateurs existants
restent compatibles. La nouvelle opération exige `datasets:read` et ne réclame
aucune capability d'effet.

## Security, data and operations

Le workspace vient de l'identité authentifiée. La lecture ne contacte aucun
provider, ne réserve aucun budget et ne crée aucun événement métier. La taille
de page maximale limite mémoire et réponse ; le serveur doit conserver l'ordre
ordinal et valider le contrat de sortie avant émission.

Aucune migration n'est requise : la décision projette les read models durables
déjà nécessaires à la matérialisation. Elle ne change aucune frontière
d'architecture et ne crée donc aucun nouvel ADR.

## Alternatives

Un offset serait instable sous concurrence et ne fournirait pas de reprise
déterministe. Exposer le curseur provider couplerait le contrat à une route
privée et divulguerait sa lineage. Retourner des pages `building` rendrait un
snapshot mutable observable. Ces options sont rejetées.

## Verification

Le catalogue doit valider les fixtures positives et rejeter les limites hors
borne et les injections provider. La génération doit rester reproductible sous
Node 24.14.0 ; OpenAPI, exports package, types, CLI, permissions, problèmes et
absence d'outil MCP doivent rester alignés.

## Decision record

Accepted le 2026-07-22 par Leandre Desmaretz, sans objection non résolue, sans
migration et sans nouvel ADR.
