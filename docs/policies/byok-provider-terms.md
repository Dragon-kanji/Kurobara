# Policy BYOK et conditions des providers

- Statut : garde opératoire du dépôt, pas avis juridique
- Dernière revue : 23 juillet 2026
- Portée : adapters Hunter, Prospeo, Tavily et Exa de la V1 locale

## Séparer le code du service tiers

La licence Apache-2.0 couvre le code Kurobara. Elle n'accorde aucun droit sur
une API, un compte, un quota, une réponse, une base de données, une marque ou un
logo appartenant à un provider.

Dans ce dépôt, le mot `official` dans certains identifiants techniques signifie
uniquement « adapter maintenu par le projet Kurobara ». Il ne signifie ni
adapter publié ou approuvé par le provider, ni partenariat, ni endorsement, ni
admission contractuelle.

Le mode self-hosted BYOK repose sur les règles suivantes :

- chaque opérateur utilise son propre compte et sa propre clé dans son
  environnement ;
- aucun credential, quota, résultat ou droit contractuel n'est mutualisé par le
  projet ;
- la présence d'un adapter, d'un nom de provider ou d'une clé valide ne prouve
  pas le droit d'appeler le service, de conserver, dériver ou exporter ses
  outputs ;
- l'opérateur doit vérifier les conditions de son plan, son cas d'usage, sa
  base légale et ses obligations de suppression avant d'activer une route ;
- un usage managé, la redistribution à des tiers, la constitution d'une base
  partagée, la publication de benchmarks et l'usage de logos restent désactivés
  tant qu'un accord écrit applicable ne les autorise pas explicitement.

## Décisions provider au 23 juillet 2026

Ces décisions sont conservatrices. Elles ne remplacent pas les conditions
acceptées par le titulaire du compte et doivent être relues si un provider
modifie ses textes ou si Kurobara change de mode d'exploitation.

| Provider | Composition technique | Décision contractuelle du projet | Condition d'activation |
| --- | --- | --- | --- |
| Hunter | Adapter maintenu ; route company et effets email dans l'ordre par défaut lorsqu'une clé est présente | **Contract-gated.** L'intégration via une application tierce est envisagée par les conditions, mais un service similaire ou concurrent exige un consentement écrit et aucun droit de revente ou de redistribution publique n'a été identifié. | Le titulaire du compte confirme que son usage self-hosted, local et interne est couvert. Un mode managé, partagé, revendu ou présenté comme substitut de base de données exige une confirmation écrite de Hunter. |
| Prospeo | Adapter maintenu ; recherche et enrichissement Contact dans l'ordre par défaut lorsqu'une clé est présente | **Contract-gated, usage interne seulement.** Les outputs sont annoncés pour des usages B2B internes ; revente, redistribution, publication ou divulgation à des tiers sont restreintes. | Le titulaire du compte limite l'usage à ses opérations internes, applique les demandes d'opt-out/suppression et n'utilise pas Kurobara pour fournir une base ou un service à des tiers. Un mode managé ou client exige un accord écrit et, selon le flux, un DPA. |
| Tavily | Adapter maintenu, **opt-in** via `KUROBARA_PROVIDER_ORDER` | **Contract-gated.** Les Customer Apps sont envisagées, mais l'usage API est décrit comme interne, la concurrence et les benchmarks sont restreints, et l'AUP peut affecter un pipeline de prospection. Le droit de stockage et d'export durable n'est pas suffisamment explicite pour une admission générale. | Le titulaire du compte confirme que son usage et ses exports sont couverts par son plan et l'AUP. Une confirmation écrite de Tavily est requise avant d'en faire une route de référence de sourcing ou un composant managé. |
| Exa | Adapter maintenu, **opt-in** via `KUROBARA_PROVIDER_ORDER` et fail-closed sans `KUROBARA_EXA_DATA_RIGHTS_CONFIRMED=true` | **Bloqué sous les conditions standard relues.** Les restrictions sur la copie, le stockage, la publication ou la distribution des informations obtenues, ainsi que sur les produits concurrents, sont incompatibles avec une admission générique de la verticale Kurobara. | Ne positionner l'attestation exacte et ne composer la route qu'après Additional Terms ou accord écrit couvrant explicitement le cas d'usage, la conservation, les dérivés, l'export et la qualification concurrentielle. Le booléen enregistre une déclaration opérateur ; il ne prouve pas l'accord. |

Apollo reste opt-in et PDL reste hors des routes actives. Ils ne sont pas
réadmis par cette revue.

## Contrôle de composition

L'ordre technique par défaut est `prospeo,hunter`. Tavily, Exa et Apollo ne
sont composés que si l'opérateur les ajoute explicitement à
`KUROBARA_PROVIDER_ORDER` et fournit leur clé. Ce choix explicite n'est toujours
pas une preuve de droits. Exa exige aussi
`KUROBARA_EXA_DATA_RIGHTS_CONFIRMED=true`. Toute autre valeur non vide échoue
comme configuration ambiguë ; l'absence, la chaîne vide ou `false` conserve la
route fermée. Le titulaire ne doit positionner `true` qu'après avoir obtenu et
conservé les termes écrits applicables.

Fragment de configuration, à intégrer à un environnement worker complet
uniquement lorsque les droits applicables ont été confirmés :

```dotenv
KUROBARA_PROVIDER_ORDER=tavily
TAVILY_API_KEY=replace-with-your-own-key
```

Exa ne doit pas apparaître dans cet ordre et son attestation ne doit pas être
positionnée sous les conditions standard relues.

## Outputs, rétention et suppression

Kurobara conserve une provenance et peut produire un export local. Cette
capacité technique ne transforme pas un output provider en donnée librement
redistribuable. L'opérateur doit notamment :

1. limiter la collecte aux données nécessaires et autorisées ;
2. borner résultats, appels, budget et durée avant le premier effet ;
3. réserver les exports contenant des contacts aux destinataires autorisés ;
4. propager les restrictions, opt-outs, expirations et suppressions ;
5. ne pas conserver une donnée lorsqu'une obligation provider ou légale impose
   sa suppression, même si un snapshot Kurobara est par ailleurs immuable ;
6. ne jamais committer de réponse live, credential ou fixture dérivée d'un
   provider sans droit de redistribution explicite.

Les gates Kurobara, y compris les permissions d'export et les décisions de
droits provider, réduisent le risque opérationnel. Ils ne certifient pas un
contrat, une base légale ou un droit de redistribution.

## Marques et attribution

Les noms Hunter, Prospeo, Tavily et Exa sont employés uniquement pour décrire
factuellement les adapters et la compatibilité technique. Le dépôt n'embarque
aucun logo provider et ne revendique aucun partenariat, endorsement ou licence
de marque. Toute attribution supplémentaire imposée par un plan ou un accord
reste à la charge de son titulaire.

## Sources relues

- [Hunter Terms of Service](https://hunter.io/terms-of-service), texte indiqué
  comme mis à jour le 23 mai 2024, relu le 23 juillet 2026.
- [Prospeo Terms of Service](https://prospeo.io/terms-of-service),
  [DPA](https://prospeo.io/dpa) et
  [API docs](https://prospeo.io/api-docs), relus le 23 juillet 2026.
- [Tavily Terms](https://www.tavily.com/terms), texte indiqué comme mis à jour
  le 4 mai 2026, et
  [Acceptable Use Policy](https://www.tavily.com/acceptable-use-policy), relus
  le 23 juillet 2026.
- [Exa Labs Terms of Service](https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf),
  relus le 23 juillet 2026.

La qualification détaillée, les blockers de publication et leurs conditions de
levée sont conservés dans la revue privée de publication, volontairement exclue
du candidat public.
