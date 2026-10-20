# 🎯 DustIII

<div align="center">

**Dust II Defusal — Desactivación De Bombas 5v5 En Tu Navegador**  
*Un conjunto de reglas fiel a CS2 construido con Three.js: economía real, menú de compra, patrones de retroceso, penetración de paredes, utilidades, sitios de bomba y cuatro niveles de bots — servido como sitio estático sin backend.*

[![Plataforma: WebGL 2 / Módulos ES](https://img.shields.io/badge/Plataforma-WebGL%202%20%2F%20Módulos%20ES-blue.svg?style=flat-square&logo=googlechrome)](https://developer.mozilla.org/es/docs/Web/API/WebGL_API)
[![Motor: Three.js 0.170](https://img.shields.io/badge/Motor-Three.js%200.170-black.svg?style=flat-square)](https://threejs.org)
[![Reglas: Competitivo CS2](https://img.shields.io/badge/Reglas-Competitivo%20CS2-orange.svg?style=flat-square)](#rules)
[![Estado: Jugable](https://img.shields.io/badge/Estado-Jugable-success.svg?style=flat-square)](#overview)
[![Licencia: MIT](https://img.shields.io/badge/Licencia-MIT-blue.svg?style=flat-square)](license)
[![Precio: 100% Gratis Y Código Abierto](https://img.shields.io/badge/Precio-100%25%20Gratis%20Y%20Código%20Abierto-success.svg?style=flat-square)](#overview)
[![Privacidad: Cero Telemetría / 100% Local](https://img.shields.io/badge/Privacidad-Cero%20Telemetría%20%2F%20100%25%20Local-purple.svg?style=flat-square)](#privacy)

</div>

---

## 🌐 Seleccionar Idioma / Select Language / 选择语言 / 言語を選択 / Idioma / Langue / Sprache

**[English](readme.md)** •
**[简体中文](readme.zh-cn.md)** •
**[繁體中文](readme.zh-tw.md)** •
**[日本語](readme.ja.md)** •
**[Español](readme.es.md)** •
**[Français](readme.fr.md)** •
**[Deutsch](readme.de.md)**

---

## 🧭 Tabla De Contenidos

- [Descripción General Y Valor Central](#overview)
- [Características Principales](#features)
- [Controles](#controls)
- [Primeros Pasos](#start)
- [Arquitectura Y Diseño](#architecture)
- [Diagnóstico Y Verificación](#diagnostics)
- [Privacidad Y Seguridad Primero](#privacy)
- [Aviso Educativo Y De Juego Limpio](#disclaimer)
- [Licencia Y Términos](#license)

---

## ⚡ Descripción General Y Valor Central <a id="overview"></a>

DustIII es una recreación nativa del navegador del clásico ciclo de desactivación de bombas 5v5 en de_dust2. Empuñas un rifle, cuatro compañeros bot cubren ángulos contigo y cinco bots enemigos compran, rotan, ejecutan y recuperan posiciones como un equipo coordinado. Cada ronda se simula localmente en una sola página: sin cuenta, sin servicio de emparejamiento, sin descargas y sin telemetría.

El proyecto apunta a Chrome, Firefox y Safari de escritorio con WebGL 2. Una carga en frío descarga el mapa estático y el paquete de arte desde el mismo origen, y luego ejecuta la partida completa a 60+ FPS en una GPU moderna.

---

## 🎮 Características Principales <a id="features"></a>

### Reglas Competitivas Y Economía <a id="rules"></a>

- **Formato MR12**: gana el primero en alcanzar 13 rondas, los lados se intercambian tras la ronda 12 y la partida termina en la ronda 24.
- **Economía Auténtica**: $800 iniciales, tope de $16,000, una escalera de bonificación por derrota de $1,400 a $3,400, recompensas por baja y bonificaciones por plantar o desactivar.
- **Tiempo De Congelación Y Compra**: 15 segundos de congelación y una ventana de compra de 20 segundos en cada ronda.
- **Ciclo Completo De La Bomba**: plantado de 3.2 segundos, cuenta atrás del C4 de 40 segundos, desactivación de 10 segundos y 5 segundos con kit.

### Sandbox De Armas

- **34 Armas De Fuego**: pistolas, subfusiles, escopetas, rifles y ametralladoras, además de cuchillo, Zeus x27, C4 y seis granadas.
- **Modelo Balístico**: dispersión por arma, recuperación del retroceso, penetración de armadura, multiplicadores por zona de impacto, caída por distancia y penetración de paredes.
- **Patrones De Retroceso**: patrones ajustados a mano para AK-47 y M4A4, con patrones procedurales deterministas para el resto del arsenal.
- **Miras, Silenciadores Y Ráfagas**: ópticas de AWP y SSG 08, supresión de M4A1-S y USP-S, y modo ráfaga de Glock-18 y FAMAS.

### Utilidad Y Juego De Bomba

- **Granadas**: HE, flashbang, humo, molotov, incendiaria y señuelo, con disponibilidad distinta por bando.
- **Chaleco Y Kits De Desactivación**: la armadura absorbe daño según la zona de impacto y los kits de los CT reducen a la mitad el tiempo de desactivación.
- **Armas Caídas**: los jugadores eliminados sueltan su arma primaria y secundaria para recogerlas.

### IA Directora De Bots Tácticos

- **Cuatro Niveles De Dificultad**: fácil, normal, difícil y experto ajustan tiempo de reacción, velocidad de giro, error de puntería, control del retroceso, campo de visión y audición.
- **Directores De Equipo**: cada bando tiene un director de ejecución que asigna roles, ordena rotaciones y coordina defensas y recuperaciones tras el plantado.
- **Modelo De Percepción**: comprobación de línea de visión, propagación del sonido, reacción a los destellos y memoria del objetivo que decae con el tiempo.
- **38 Bots Con Nombre**: una plantilla estable mantiene legibles los marcadores entre partidas.

### Mundo Dust II

- **Cobertura Completa De Callouts**: T Spawn, Outside Long, Long Doors, Pit, A Site, CT Spawn, Catwalk, Mid, Xbox, B Tunnels, B Site y el resto del mapa.
- **Datos De Mapa Precalculados**: geometría, props, rampas y navegación se hornean previamente y se distribuyen como artefactos estáticos compactos.
- **Raycasts Acelerados Por BVH**: balas, granadas, línea de visión y movimiento consultan una jerarquía de volúmenes delimitadores acelerada.
- **Rampas De Clip**: rampas invisibles solo para movimiento suavizan las escaleras sin bloquear balas ni granadas.

### HUD Y Presentación

- **HUD Estilo CS2**: radar giratorio, menú de compra, marcador, feed de bajas, temporizador de ronda, dinero, armadura y munición.
- **Modelos Procedurales**: las armas y los personajes se ensamblan a partir de primitivas al cargar, por lo que no se necesitan archivos de modelo externos.
- **ViewModel En Primera Persona**: animaciones de desenfundado, reposo, inspección, recarga y disparo dirigidas por el estado del arma.
- **Audio Sintetizado**: disparos posicionales, pasos, recargas, líneas de radio y pitidos de la bomba.
- **Interfaz Bilingüe**: etiquetas en inglés y chino simplificado en la pantalla de carga, el menú de compra y los avisos.

---

## 🕹 Controles <a id="controls"></a>

| Acción | Tecla |
| :--- | :--- |
| Moverse | `W` `A` `S` `D` |
| Mirar | Ratón |
| Saltar | `Space` |
| Agacharse | `Ctrl` |
| Caminar | `Shift` |
| Disparar | Botón izquierdo del ratón |
| Apuntar | Botón derecho del ratón |
| Menú De Compra | `B` |
| Recoger O Desactivar | `E` |
| Recargar | `R` |
| Inspeccionar Arma | `F` |
| Soltar Arma | `G` |
| Arma Anterior | `Q` |
| Primaria / Secundaria / Cuchillo / Granada / C4 | `1` `2` `3` `4` `5` |
| Marcador | `Tab` |
| Comandos De Radio | `Z` `X` `C` |
| Pausa | `Esc` |

---

## 🚀 Primeros Pasos <a id="start"></a>

### Requisitos

- Un navegador de escritorio moderno con WebGL 2 y soporte de módulos ES.
- Un servidor local de archivos estáticos. Abrir `index.html` directamente desde el disco no funciona porque el juego usa módulos ES y un import map.
- Acceso a los módulos fijados de jsDelivr en la primera carga.

### Servir El Juego Localmente

```bash
git clone https://github.com/AMFI-Disable/DustIII.git
cd DustIII
python3 -m http.server 8000
```

Abre `http://localhost:8000` en tu navegador y haz clic en el lienzo para capturar el ratón.

### Alojamiento Estático

Como el paquete es completamente estático, sirve cualquier alojamiento: GitHub Pages, Cloudflare Pages, Netlify o `nginx`. Apunta el host a la raíz del repositorio y usa `index.html` como documento de entrada.

> [!NOTE]
> El runtime importa `three`, `three/addons/` y `three-mesh-bvh` desde jsDelivr mediante el import map de `index.html`. Para un despliegue totalmente offline, copia esos tres paquetes en `js/vendor/` y reescribe las entradas del import map.

---

## 🧱 Arquitectura Y Diseño <a id="architecture"></a>

El juego es una aplicación plana de módulos ES sin paso de compilación. `index.html` posee el shell del DOM, los estilos del HUD y el import map; `js/` posee la simulación y la presentación.

```text
DustIII/
├── index.html                  # Shell, estilos del HUD, pantalla de carga, import map
├── js/
│   ├── main.js                 # Arranque, entrada, cámara, bucle de render, espectador
│   ├── game.js                 # Rondas, economía, compra, disparo, daño, bomba
│   ├── player.js               # Movimiento, colisión y postura del jugador
│   ├── bots.js                 # Cerebros de bots y directores de equipo
│   ├── weapon_data.js          # Estadísticas, ranuras, reglas, zonas de impacto
│   ├── weapon_models.js        # Mallas procedurales de armas y rigs de animación
│   ├── characters.js           # Mallas y skins procedurales de personajes
│   ├── viewmodel.js            # Estado de animación del arma en primera persona
│   ├── hud.js                  # Radar, menú de compra, marcador, feed de bajas
│   ├── audio.js                # Motor de audio posicional y sintetizado
│   ├── world.js                # Ensamblaje del mapa, materiales, BVH, iluminación
│   ├── world_data.js           # Callouts, spawns, sitios, anclas de navegación
│   ├── world_nav.js            # Rejilla de navegación y búsqueda de rutas
│   ├── world_props.js          # Colocación de props y decoración
│   ├── world_materials.js      # Mezcla de superficies PBR
│   └── fx*.js                  # Partículas, humo, fuego, calcomanías, postprocesado
└── assets/
    ├── chars/                  # Texturas de personajes
    ├── fx/                     # Sprites, calcomanías, fogonazos, hojas de humo
    ├── tex/                    # Conjuntos de texturas PBR albedo, normal y ORM
    ├── weapons/                # Referencias de arte de armas
    ├── world/                  # Mapa horneado, props, rampas, datos de navegación
    └── ui/                     # Fuentes, iconos, imagen de radar, manifiesto de UI
```

### Notas De Diseño

- **Mundo Dirigido Por Datos**: las cargas estáticas del mapa viven en `assets/world/` y se obtienen una vez al cargar, manteniendo el código de simulación libre de geometría codificada.
- **Fuente Única De Reglas**: `RULES` en `js/weapon_data.js` es la única autoridad para tiempos de ronda, economía y duración de la partida.
- **Arte Procedural**: las armas y los personajes se generan por código, lo que evita archivos binarios de modelos de gran tamaño.
- **Autoridad Solo Del Cliente**: bots, daño y economía son simulaciones locales deterministas. No hay servidor en el que confiar ni sincronización de red.

---

## 🧪 Diagnóstico Y Verificación <a id="diagnostics"></a>

- **Modo Sin Render**: añade `?norender` a la URL para omitir el bucle de render costoso manteniendo viva la simulación. Útil para cargas de humo automatizadas y perfilado.
- **Consola Del Navegador**: todos los sistemas registran en la consola y los fallos de carga indican el recurso o módulo ausente.
- **Prueba Manual De Humo**: carga la página, confirma que la barra llega al 100 por ciento, haz clic para bloquear el puntero, compra una pistola y completa una ronda.
- **Integridad De Recursos**: cada textura, icono, fuente y carga horneada referenciada por `js/` se incluye en `assets/`; el cargador informa de inmediato cualquier ruta ausente.

Este repositorio no incluye una suite automatizada de pruebas unitarias. Se agradecen contribuciones que añadan sondas de motor sin interfaz.

---

## 🔒 Privacidad Y Seguridad Primero <a id="privacy"></a>

- **Cero Telemetría**: sin analítica, sin píxeles de seguimiento, sin informes de fallos y sin identificadores.
- **Cero Backend**: el juego es totalmente estático. No existe cuenta, emparejamiento ni base de datos.
- **Estado Solo Local**: los ajustes, el estado de la partida y las preferencias permanecen en la pestaña del navegador o en el almacenamiento local.
- **Dependencias Auditables**: las únicas dependencias de runtime son los paquetes fijados de jsDelivr declarados en el import map de `index.html`. Revísalos o cópialos localmente antes de desplegar en un entorno sensible.
- **Sin Descargas Binarias**: la distribución se realiza mediante checkouts de código y alojamiento estático. No se publican instaladores ni ejecutables desde este repositorio.

---

## ⚖ Aviso Educativo Y De Juego Limpio <a id="disclaimer"></a>

> [!CAUTION]
> **AVISO IMPORTANTE Y DESCARGO DE RESPONSABILIDAD**:
> Este proyecto es una recreación educativa no oficial hecha por fans para estudiar renderizado 3D en tiempo real, simulación de estado de juego y toma de decisiones de bots en el navegador.
> No está afiliado, respaldado ni patrocinado por Valve Corporation. Counter-Strike, Dust II y las marcas relacionadas son propiedad de sus respectivos dueños.
> Toda la geometría, modelos, texturas, audio y código de este repositorio son originales o generados proceduralmente. Si crees que algún material artístico infringe tus derechos, abre un informe de seguridad privado para que sea revisado y reemplazado.

---

## 📄 Licencia Y Términos <a id="license"></a>

Distribuido bajo la [Licencia MIT](license). Copyright (c) 2026 AMFI-Disable.
