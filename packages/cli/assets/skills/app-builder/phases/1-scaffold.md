# Fase 1 — Scaffold

## Objetivo

Un monorepo con la app Expo/React Native booteando en el device del usuario, el kit de primitivos de UI instalado y el contrato de tokens de dos capas scaffoldeado con valores neutros de Capa 1 (estructura).

## Protocolo

1. **Template dorado primero, versión resuelta en vivo.** Antes de lanzar, resuelve el SDK actual con `npm view expo version` y pinéalo exacto en el prompt — NUNCA escribas una versión de memoria (el prior de entrenamiento de un agente tier bajo le gana a "sigue el playbook"). Tres caminos: (a) existe `template/` en el skill y está al día → copiar + rename + `npm install` (con lockfile), sin volver a correr CLIs de scaffold; (b) el template quedó atrás del SDK resuelto → copiar y luego `npx expo install expo@^<resuelto>` + `npx expo install --fix` + `npx expo-doctor`, y al pasar el gate re-congelar el árbol actualizado como nuevo template; (c) no hay template → scaffold por CLI y congelar el resultado como template inicial.
2. **Un solo monorepo.** Layout: `apps/mobile` (Expo/RN), `packages/*` para dominio compartido, config de backend en la raíz. El scaffold es parte de la feature, no un prerequisito.
3. **Package manager: npm, no pnpm.** El layout de symlinks aislados de pnpm rompe la resolución de Metro.
4. **Kit de primitivos vía el CLI de react-native-reusables.** Copia (owned, editable) en `components/ui/*`: Button, Input, Card, Text, más composites propios ListRow, Chip/Badge, ScreenHeader, LoadingState, EmptyState. Nunca importes primitivos de un paquete en runtime.
5. **Contrato de tokens de dos capas en `lib/theme.ts`.** Capa 1 (estructura, ahora) con valores neutros: alturas de control, escala de radios, escala de espaciado, anchos de borde, slots de escala tipográfica. Sin decisiones de color: eso es Capa 2 en la fase 5.
6. **Valida con `expo export`**, no solo `tsc`: tsc no ejercita la config de babel/metro. Cap explícito a validaciones largas (`expo start` hasta el banner de espera, con timeout) e installs con `npm install --prefer-offline`.

## Skills

- `expo-runtime`, `turbo-workspaces` — runtime de Expo, expo-sqlite, gotchas de Metro y layout de workspaces del monorepo.
- `typescript`, `ponytail` — si alguna de estas skills no está instalada en tu motor (no aparece en tu catálogo de skills disponibles), continúa sin ella o instálala antes de arrancar la fase; Argos no valida automáticamente disponibilidad de skills externas por fase.

## Cómo verificar el gate

- La app bootea en el device real del usuario.
- Los primitivos existen en `components/ui/*` y cada uno consume tokens de `lib/theme.ts` — cero dimensiones inline.
- Sin lockfile ajeno (`pnpm-lock.yaml`, `yarn.lock`): su presencia es fallo de gate automático.
- Sin scope especulativo: nada fuera del output declarado de la fase (carpetas extra, placeholders "para la fase N") — fallo de gate aunque sea inofensivo.
- El SDK instalado coincide con el resuelto en vivo al launch (verificar `expo` en package.json contra `npm view expo version`, no contra el reporte del agente).

## Artifacts

- `apps/mobile` scaffold, `components/ui/*`, `lib/theme.ts` (tokens Capa 1).
- Engram: `app/{app}/phase-1`.

## Modelo

`haiku`, effort bajo: trabajo mecánico de scaffold.
