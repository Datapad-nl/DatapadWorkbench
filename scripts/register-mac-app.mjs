import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electronDir = dirname(require.resolve('electron/package.json'))

// Electron 44+ has no npm postinstall. electron-vite reads path.txt itself and
// throws "Electron uninstall" when install.js has never written it. install.js
// exits immediately when the binary for this platform is already present.
const electronInstall = join(electronDir, 'install.js')
if (existsSync(electronInstall)) {
  execFileSync(process.execPath, [electronInstall], { stdio: 'inherit' })
}

if (process.platform !== 'darwin') process.exit(0)

const BUNDLE_ID = 'com.datapad.workbench'
const APP_NAME = 'Datapad Workbench'
const MIC_USAGE =
  'Datapad Workbench listens on this Mac so you can talk to Grok in conversation mode.'

const distDir = join(electronDir, 'dist')
const distApp = join(distDir, 'Electron.app')
const installedApp = join(homedir(), 'Applications', `${APP_NAME}.app`)
// Shells registered under the app's previous name. They are replaced by the
// renamed shell and removed once it is installed.
const legacyApps = ['Grok Build Workbench'].flatMap((name) => [
  join(homedir(), 'Applications', `${name}.app`),
  join('/Applications', `${name}.app`)
])
const entitlements = join(root, 'resources/mac/entitlements.mac.plist')
const icon = join(root, 'resources/icon.icns')

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts })
}

function signingIdentity() {
  const out = run('security', ['find-identity', '-v', '-p', 'codesigning'])
  const development = out.match(/"(Apple Development: [^"]+)"/)
  if (development) return development[1]
  const developerId = out.match(/"(Developer ID Application: [^"]+)"/)
  if (developerId) return developerId[1]
  return '-'
}

function setString(plist, key, value) {
  run('plutil', ['-replace', key, '-string', value, plist])
}

function helperBundleId(folderName) {
  const match = folderName.match(/^Electron Helper(?: \((.+)\))?\.app$/)
  if (!match) return `${BUNDLE_ID}.helper`
  return match[1] ? `${BUNDLE_ID}.helper.${match[1]}` : `${BUNDLE_ID}.helper`
}

function patchInfo(plist, { id, name } = {}) {
  if (!existsSync(plist)) return
  if (id) setString(plist, 'CFBundleIdentifier', id)
  if (name) {
    setString(plist, 'CFBundleName', name)
    setString(plist, 'CFBundleDisplayName', name)
  }
  setString(plist, 'NSMicrophoneUsageDescription', MIC_USAGE)
  setString(plist, 'NSAudioCaptureUsageDescription', MIC_USAGE)
}

function patchApp(appPath) {
  patchInfo(join(appPath, 'Contents/Info.plist'), { id: BUNDLE_ID, name: APP_NAME })
  if (existsSync(icon)) copyFileSync(icon, join(appPath, 'Contents/Resources/electron.icns'))
  const frameworks = join(appPath, 'Contents/Frameworks')
  if (!existsSync(frameworks)) return
  for (const entry of readdirSync(frameworks)) {
    if (!entry.endsWith('.app')) continue
    patchInfo(join(frameworks, entry, 'Contents/Info.plist'), { id: helperBundleId(entry) })
  }
}

function walkFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walkFiles(next, acc)
    else acc.push(next)
  }
  return acc
}

function isMachO(file) {
  try {
    return run('file', ['-b', file]).includes('Mach-O')
  } catch {
    return false
  }
}

function signTarget(identity, target, withEntitlements) {
  const args = ['--force', '--sign', identity]
  if (identity !== '-') {
    args.push('--timestamp', '--options', 'runtime')
  }
  if (withEntitlements) args.push('--entitlements', entitlements)
  args.push(target)
  execFileSync('codesign', args, { stdio: 'inherit' })
}

function signApp(appPath, identity) {
  const files = walkFiles(appPath).sort((a, b) => b.length - a.length)
  for (const file of files) {
    if (isMachO(file)) signTarget(identity, file, false)
  }
  const bundles = []
  function collectBundles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = join(dir, entry.name)
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      collectBundles(next)
      if (entry.name.endsWith('.app') || entry.name.endsWith('.framework')) bundles.push(next)
    }
  }
  collectBundles(appPath)
  bundles.sort((a, b) => b.length - a.length)
  for (const bundle of bundles) signTarget(identity, bundle, bundle.endsWith('.app'))
  signTarget(identity, appPath, true)
}

const hasInfo = (appPath) => existsSync(join(appPath, 'Contents/Info.plist'))
const sourceApp =
  existsSync(distApp) && !lstatSync(distApp).isSymbolicLink()
    ? distApp
    : [installedApp, ...legacyApps].find(hasInfo) ?? installedApp
if (!hasInfo(sourceApp)) {
  console.warn('register-mac-app: no packable Electron.app')
  process.exit(0)
}

const identity = signingIdentity()
console.log(`register-mac-app: signing as ${identity}`)

mkdirSync(dirname(installedApp), { recursive: true })
if (sourceApp !== installedApp) {
  execFileSync('ditto', [sourceApp, installedApp], { stdio: 'inherit' })
}
patchApp(installedApp)
signApp(installedApp, identity)
const systemApp = join('/Applications', `${APP_NAME}.app`)
// An installer from GitHub Releases puts the real app there. Never copy the dev shell over it.
const releaseInstalled = existsSync(join(systemApp, 'Contents/Resources/app.asar'))
if (!releaseInstalled) {
  try {
    execFileSync('ditto', [installedApp, systemApp], { stdio: 'inherit' })
  } catch {
    console.warn('register-mac-app: could not copy to /Applications (permissions?)')
  }
}
const useSystemApp = !releaseInstalled && existsSync(systemApp)

for (const legacy of legacyApps) {
  try {
    rmSync(legacy, { recursive: true, force: true })
  } catch {
    console.warn(`register-mac-app: could not remove ${legacy}`)
  }
}

const launchApp = useSystemApp ? systemApp : installedApp
if (!existsSync(distApp) || !lstatSync(distApp).isSymbolicLink() || realpathSync(distApp) !== realpathSync(launchApp)) {
  rmSync(distApp, { recursive: true, force: true })
  symlinkSync(launchApp, distApp)
}

const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
if (existsSync(lsregister)) {
  run(lsregister, ['-f', installedApp])
  if (useSystemApp) run(lsregister, ['-f', systemApp])
}

execFileSync('codesign', ['--verify', '--deep', '--strict', installedApp], { stdio: 'inherit' })
console.log(`register-mac-app: ${installedApp}`)
console.log(`register-mac-app: ${APP_NAME} (${BUNDLE_ID})`)
