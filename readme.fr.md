# 🎯 DustIII

<div align="center">

**Dust II Defusal — Désamorçage De Bombe 5v5 Dans Votre Navigateur**  
*Un ensemble de règles fidèle à CS2 construit avec Three.js : économie réelle, menu d'achat, motifs de recul, tir à travers les murs, utilitaires, sites de bombe et quatre niveaux de bots — servi comme site statique sans backend.*

[![Plateforme: WebGL 2 / Modules ES](https://img.shields.io/badge/Plateforme-WebGL%202%20%2F%20Modules%20ES-blue.svg?style=flat-square&logo=googlechrome)](https://developer.mozilla.org/fr/docs/Web/API/WebGL_API)
[![Moteur: Three.js 0.170](https://img.shields.io/badge/Moteur-Three.js%200.170-black.svg?style=flat-square)](https://threejs.org)
[![Règles: Compétitif CS2](https://img.shields.io/badge/Règles-Compétitif%20CS2-orange.svg?style=flat-square)](#rules)
[![Statut: Jouable](https://img.shields.io/badge/Statut-Jouable-success.svg?style=flat-square)](#overview)
[![Licence: MIT](https://img.shields.io/badge/Licence-MIT-blue.svg?style=flat-square)](license)
[![Prix: 100% Gratuit Et Open Source](https://img.shields.io/badge/Prix-100%25%20Gratuit%20Et%20Open%20Source-success.svg?style=flat-square)](#overview)
[![Confidentialité: Zéro Télémétrie / 100% Local](https://img.shields.io/badge/Confidentialité-Zéro%20Télémétrie%20%2F%20100%25%20Local-purple.svg?style=flat-square)](#privacy)

</div>

---

## 🌐 Choisir La Langue / Select Language / 选择语言 / 言語を選択 / Idioma / Langue / Sprache

**[English](readme.md)** •
**[简体中文](readme.zh-cn.md)** •
**[繁體中文](readme.zh-tw.md)** •
**[日本語](readme.ja.md)** •
**[Español](readme.es.md)** •
**[Français](readme.fr.md)** •
**[Deutsch](readme.de.md)**

---

## 🧭 Table Des Matières

- [Aperçu Et Valeur Fondamentale](#overview)
- [Fonctionnalités Principales](#features)
- [Commandes](#controls)
- [Démarrage](#start)
- [Architecture Et Conception](#architecture)
- [Diagnostics Et Vérification](#diagnostics)
- [Confidentialité Et Sécurité](#privacy)
- [Avertissement Éducatif Et Fair-Play](#disclaimer)
- [Licence Et Conditions](#license)

---

## ⚡ Aperçu Et Valeur Fondamentale <a id="overview"></a>

DustIII est une recréation native dans le navigateur du cycle classique de désamorçage de bombe 5v5 sur de_dust2. Vous tenez un fusil, quatre coéquipiers bots couvrent les angles avec vous et cinq bots ennemis achètent, tournent, exécutent et reprennent les positions comme une équipe coordonnée. Chaque manche est simulée localement dans une seule page : aucun compte, aucun service de matchmaking, aucun téléchargement et aucune télémétrie.

Le projet cible Chrome, Firefox et Safari de bureau avec WebGL 2. Un chargement à froid récupère la carte statique et le pack d'art depuis la même origine, puis exécute la partie complète à plus de 60 FPS sur un GPU moderne.

---

## 🎮 Fonctionnalités Principales <a id="features"></a>

### Règles Compétitives Et Économie <a id="rules"></a>

- **Format MR12** : le premier à 13 manches gagne, les camps échangent après la manche 12 et la partie se termine à la manche 24.
- **Économie Authentique** : 800 $ au départ, plafond à 16 000 $, échelle de bonus de défaite de 1 400 $ à 3 400 $, récompenses par élimination et bonus de pose ou de désamorçage.
- **Temps De Gel Et D'Achat** : 15 secondes de gel et une fenêtre d'achat de 20 secondes à chaque manche.
- **Cycle Complet De La Bombe** : pose en 3,2 secondes, compte à rebours C4 de 40 secondes, désamorçage en 10 secondes et 5 secondes avec kit.

### Bac À Sable D'Armes

- **34 Armes À Feu** : pistolets, pistolets-mitrailleurs, fusils à pompe, fusils et mitrailleuses, plus le couteau, le Zeus x27, le C4 et six grenades.
- **Modèle Balistique** : dispersion par arme, récupération du recul, pénétration d'armure, multiplicateurs par zone de touche, atténuation avec la distance et pénétration des murs.
- **Motifs De Recul** : motifs ajustés à la main pour l'AK-47 et la M4A4, avec des motifs procéduraux déterministes pour le reste de l'arsenal.
- **Lunettes, Silencieux Et Rafales** : optiques AWP et SSG 08, suppression M4A1-S et USP-S, et mode rafale Glock-18 et FAMAS.

### Utilitaires Et Jeu De Bombe

- **Grenades** : HE, flashbang, fumigène, molotov, incendiaire et leurre, avec une disponibilité propre à chaque camp.
- **Gilet Et Kits De Désamorçage** : l'armure absorbe les dégâts selon la zone touchée et les kits CT divisent par deux le temps de désamorçage.
- **Armes Lâchées** : les joueurs éliminés lâchent leur arme principale et secondaire, récupérables.

### IA Directrice De Bots Tactiques

- **Quatre Niveaux De Difficulté** : facile, normal, difficile et expert règlent le temps de réaction, la vitesse de rotation, l'erreur de visée, le contrôle du recul, le champ de vision et l'ouïe.
- **Directeurs D'Équipe** : chaque camp dispose d'un directeur d'exécution qui attribue les rôles, ordonne les rotations et coordonne les défenses et reprises après la pose.
- **Modèle De Perception** : vérification de ligne de vue, propagation du son, réaction aux flashs et mémoire de cible qui décroît avec le temps.
- **38 Bots Nommés** : un effectif stable garde les tableaux de score lisibles d'une partie à l'autre.

### Monde Dust II

- **Couverture Complète Des Callouts** : T Spawn, Outside Long, Long Doors, Pit, A Site, CT Spawn, Catwalk, Mid, Xbox, B Tunnels, B Site et le reste de la carte.
- **Données De Carte Précalculées** : géométrie, props, rampes et navigation sont précalculés et livrés sous forme d'artefacts statiques compacts.
- **Raycasts Accélérés Par BVH** : balles, grenades, ligne de vue et déplacements interrogent une hiérarchie de volumes englobants accélérée.
- **Rampes De Clip** : des rampes invisibles réservées au mouvement adoucissent les escaliers sans bloquer les balles ni les grenades.

### HUD Et Présentation

- **HUD Style CS2** : radar rotatif, menu d'achat, tableau des scores, fil des éliminations, chronomètre de manche, argent, armure et munitions.
- **Modèles Procéduraux** : les armes et les personnages sont assemblés à partir de primitives au chargement, sans fichier de modèle externe.
- **Vue Première Personne** : animations de dégainé, repos, inspection, rechargement et tir pilotées par l'état de l'arme.
- **Audio Synthétisé** : tirs positionnels, pas, rechargements, lignes radio et bips de la bombe.
- **Interface Bilingue** : libellés en anglais et en chinois simplifié sur l'écran de chargement, le menu d'achat et les invites.

---

## 🕹 Commandes <a id="controls"></a>

| Action | Touche |
| :--- | :--- |
| Se Déplacer | `W` `A` `S` `D` |
| Regarder | Souris |
| Sauter | `Space` |
| S'Accroupir | `Ctrl` |
| Marcher | `Shift` |
| Tirer | Bouton gauche de la souris |
| Viser | Bouton droit de la souris |
| Menu D'Achat | `B` |
| Ramasser Ou Désamorcer | `E` |
| Recharger | `R` |
| Inspecter L'Arme | `F` |
| Lâcher L'Arme | `G` |
| Arme Précédente | `Q` |
| Principale / Secondaire / Couteau / Grenade / C4 | `1` `2` `3` `4` `5` |
| Tableau Des Scores | `Tab` |
| Commandes Radio | `Z` `X` `C` |
| Pause | `Esc` |

---

## 🚀 Démarrage <a id="start"></a>

### Prérequis

- Un navigateur de bureau moderne avec WebGL 2 et prise en charge des modules ES.
- Un serveur local de fichiers statiques. Ouvrir `index.html` directement depuis le disque ne fonctionne pas, car le jeu utilise des modules ES et un import map.
- Un accès aux modules jsDelivr épinglés au premier chargement.

### Lancer Le Jeu En Local

```bash
git clone https://github.com/AMFI-Disable/DustIII.git
cd DustIII
python3 -m http.server 8000
```

Ouvrez `http://localhost:8000` dans votre navigateur et cliquez sur le canevas pour capturer la souris.

### Hébergement Statique

Le paquet étant entièrement statique, tout hébergeur convient : GitHub Pages, Cloudflare Pages, Netlify ou `nginx`. Pointez l'hôte vers la racine du dépôt et servez `index.html` comme document d'entrée.

> [!NOTE]
> Le runtime importe `three`, `three/addons/` et `three-mesh-bvh` depuis jsDelivr via l'import map de `index.html`. Pour un déploiement totalement hors ligne, copiez ces trois paquets dans `js/vendor/` et réécrivez les entrées de l'import map.

---

## 🧱 Architecture Et Conception <a id="architecture"></a>

Le jeu est une application plate en modules ES sans étape de compilation. `index.html` porte la coque DOM, les styles du HUD et l'import map ; `js/` porte la simulation et la présentation.

```text
DustIII/
├── index.html                  # Coque, styles HUD, écran de chargement, import map
├── js/
│   ├── main.js                 # Démarrage, entrées, caméra, boucle de rendu, spectateur
│   ├── game.js                 # Manches, économie, achat, tir, dégâts, bombe
│   ├── player.js               # Déplacement, collision et posture du joueur
│   ├── bots.js                 # Cerveaux des bots et directeurs d'équipe
│   ├── weapon_data.js          # Statistiques, emplacements, règles, zones de touche
│   ├── weapon_models.js        # Maillages procéduraux d'armes et rigs d'animation
│   ├── characters.js           # Maillages et skins procéduraux de personnages
│   ├── viewmodel.js            # État d'animation de l'arme en première personne
│   ├── hud.js                  # Radar, menu d'achat, scores, fil des éliminations
│   ├── audio.js                # Moteur audio positionnel et synthétisé
│   ├── world.js                # Assemblage de la carte, matériaux, BVH, éclairage
│   ├── world_data.js           # Callouts, spawns, sites, ancres de navigation
│   ├── world_nav.js            # Grille de navigation et recherche de chemin
│   ├── world_props.js          # Placement des props et décoration
│   ├── world_materials.js      # Mélange de surfaces PBR
│   └── fx*.js                  # Particules, fumée, feu, décalques, post-traitement
└── assets/
    ├── chars/                  # Textures de personnages
    ├── fx/                     # Sprites, décalques, flashs de bouche, planches de fumée
    ├── tex/                    # Jeux de textures PBR albédo, normale et ORM
    ├── weapons/                # Références d'art des armes
    ├── world/                  # Carte précalculée, props, rampes, navigation
    └── ui/                     # Polices, icônes, image du radar, manifeste UI
```

### Notes De Conception

- **Monde Piloté Par Les Données** : les charges statiques de la carte vivent dans `assets/world/` et sont récupérées une fois au chargement, ce qui évite de coder la géométrie en dur dans la simulation.
- **Source Unique Des Règles** : `RULES` dans `js/weapon_data.js` est la seule autorité pour les durées de manche, l'économie et la longueur de la partie.
- **Art Procédural** : les armes et les personnages sont générés par le code, ce qui évite de gros fichiers binaires de modèles.
- **Autorité Côté Client** : bots, dégâts et économie sont des simulations locales déterministes. Aucun serveur à qui faire confiance, aucune synchronisation réseau.

---

## 🧪 Diagnostics Et Vérification <a id="diagnostics"></a>

- **Mode Sans Rendu** : ajoutez `?norender` à l'URL pour sauter la boucle de rendu coûteuse tout en gardant la simulation active. Utile pour les chargements de test automatisés et le profilage.
- **Console Du Navigateur** : tous les systèmes journalisent dans la console et les échecs de chargement nomment la ressource ou le module manquant.
- **Test De Fumée Manuel** : chargez la page, vérifiez que la barre atteint 100 pour cent, cliquez pour verrouiller le pointeur, achetez un pistolet et terminez une manche.
- **Intégrité Des Ressources** : chaque texture, icône, police et charge précalculée référencée par `js/` est livrée dans `assets/` ; le chargeur signale immédiatement tout chemin manquant.

Ce dépôt ne contient pas de suite de tests unitaires automatisés. Les contributions ajoutant des sondes de moteur sans interface sont les bienvenues.

---

## 🔒 Confidentialité Et Sécurité <a id="privacy"></a>

- **Zéro Télémétrie** : aucune analytique, aucun pixel de suivi, aucun rapport de plantage et aucun identifiant.
- **Zéro Backend** : le jeu est entièrement statique. Aucun compte, matchmaking ou service de base de données n'existe.
- **État Uniquement Local** : les réglages, l'état de la partie et les préférences restent dans l'onglet du navigateur ou le stockage local.
- **Dépendances Auditables** : les seules dépendances d'exécution sont les paquets jsDelivr épinglés déclarés dans l'import map de `index.html`. Auditez-les ou copiez-les localement avant un déploiement en environnement sensible.
- **Aucun Téléchargement Binaire** : la distribution passe par le code source et l'hébergement statique. Aucun installateur ni exécutable n'est publié depuis ce dépôt.

---

## ⚖ Avertissement Éducatif Et Fair-Play <a id="disclaimer"></a>

> [!CAUTION]
> **AVIS IMPORTANT ET CLAUSE DE NON-RESPONSABILITÉ** :
> Ce projet est une recréation éducative non officielle réalisée par des fans pour étudier le rendu 3D temps réel, la simulation d'état de jeu et la prise de décision des bots dans le navigateur.
> Il n'est ni affilié, ni approuvé, ni sponsorisé par Valve Corporation. Counter-Strike, Dust II et les marques associées appartiennent à leurs propriétaires respectifs.
> Toute la géométrie, les modèles, les textures, l'audio et le code de ce dépôt sont originaux ou générés procéduralement. Si vous estimez qu'un élément artistique porte atteinte à vos droits, ouvrez un rapport de sécurité privé afin qu'il soit examiné et remplacé.

---

## 📄 Licence Et Conditions <a id="license"></a>

Distribué sous la [Licence MIT](license). Copyright (c) 2026 AMFI-Disable.
