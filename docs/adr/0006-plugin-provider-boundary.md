# ADR-0006 — Frontière staged des plugins et providers

- Statut : **Accepté**
- Date : **2026-07-20**
- Décideur : Leandre
- RFC lié : [RFC-0002](../rfcs/0002-plugin-sidecar-and-run-input.md)

## Contexte

Le premier provider réel ne doit pas imposer au kernel ses choix d'API,
d'authentification, de coût ou de reprise. Au moment de la décision, la
fondation locale possédait déjà un manifest strict et un input applicatif borné,
mais cette preuve ne fournissait ni SDK fonctionnel, ni sidecar, ni credential,
ni contrôle réseau ou provider.

## Décision

Kurobara retient une frontière provider-neutral issue des contrats canoniques.
La surface SDK retenue couvre `describe`, `validateConfig`, `estimate`,
`execute`, `lookup`, `normalize`, `health` et `classifyError` sans dépendre du
kernel, de l'application ou de l'infrastructure. L'input V1 est JSON, inline et
borné à 65 536 octets canoniques ; son contenu réside dans un record applicatif
tenant-scoped lié au `RunPlan`, jamais dans le kernel.

Les contrats fonctionnels utilisent une enveloppe canonique fermée
`PluginProtocolMessage` avec `apiVersion`, `direction`, `method` et `payload` ;
`apiVersion` vaut `dev.kurobara.plugin-protocol/v1`. Le futur profil sidecar la
place dans `params` d'une requête JSON-RPC `plugin.<method>` ou dans `result` de
sa réponse. L'`id` JSON-RPC reste une corrélation technique, jamais l'identité
de l'effet.

Une exécution transporte la quote exacte admise avec sa limite de coût. Une
issue ambiguë peut conserver une référence d'opération externe sûre pour la
réconciliation, sans autoriser de nouvelle exécution. La classification
d'erreur partagée n'accepte que des faits fermés et expurgés ; aucun message,
header, body, URL, stack ou credential provider ne traverse cette frontière.

Un provider sans primitive d'idempotence ni lookup déclare obligatoirement la
variante fermée `idempotency.mode=none`, `lookup.mode=none` et
`authoritativeNotFound=false`. Le SDK conserve `lookup` dans la surface fixe
mais n'appelle pas l'implémentation de l'adapter et retourne seulement
`outcome-unknown` : aucune preuve locale ne peut être inventée.

Pour cette variante one-shot, après un envoi possible ou un outcome inconnu, le
runtime n'effectue jamais de retry ni de fallback automatique. Une route de
secours n'est admissible qu'après un rejet certain avant effet. Une timeout, un
reset, un crash ou une réponse perdue restent ambigus et ferment donc la
redelivery automatique.

Ce profil futur utilise `stdio`, un document JSON compact UTF-8 par ligne LF et
un seul appel en vol. Il ne définit pas de méthode d'annulation : le host impose
la deadline et un arrêt pendant `execute` reste `outcome-unknown` sauf preuve
certaine que l'effet n'a pas commencé. Un sidecar tiers reste limité au harness
ou à un mode développeur explicitement non fiable.

La décision est staged. Elle autorise la construction locale des contrats, du
SDK, du profil sidecar et du harness ; elle ne prouve pas leur livraison et
n'autorise ni package ou endpoint public, provider live, credential dans un
sidecar, permission réseau, installation tierce ou sidecar communautaire en
production.

## Conditions des étapes suivantes

- upload et stockage objet restent sous `API-002` et `ARTIFACT-001` ;
- secrets, rotation et canal de remise exigent `AUTH-001`, `SECURITY-001` et un
  RFC d'amendement ;
- sandbox et enforcement d'egress exigent `SECURITY-001` et `DEPLOY-001` ;
- réconciliation, dépassement de borne et admission fournisseur restent sous
  `RELIABILITY-001`, `PLUGIN-002` et `PROVIDER-001` ;
- routing et fallback restent sous `POLICY-001` et `PROVIDER-002`.

## Conséquences

Un adapter peut évoluer sans contaminer le domaine ni les surfaces publiques,
et les mêmes outcomes peuvent être testés in-process ou via sidecar. En
contrepartie, aucun provider tiers ne devient exploitable avant les preuves de
compatibilité, de sécurité, d'exploitation et de provenance qui lui sont
propres.

## Révision

Un nouveau RFC est requis pour changer le framing sidecar, l'autorité de la
frontière, la sémantique des outcomes ou permettre l'exécution tierce en
production. Les choix explicitement différés suivent leurs tickets et RFC avant
activation ; ils ne sont pas décidés par anticipation dans cet ADR.
