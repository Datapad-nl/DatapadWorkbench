import { describe, expect, it } from 'vitest'
import { parseMcpServers } from './mcp'
import {
  buildServerEntry,
  installFields,
  installOptions,
  missingFields,
  rankSearchResults,
  searchWords,
  suggestServerName,
  type RegistryServer
} from './mcpRegistry'

const github: RegistryServer = {
  name: 'io.github.example/github-mcp',
  version: '1.2.0',
  remotes: [
    {
      type: 'streamable-http',
      url: 'https://api.example.com/{region}/mcp',
      variables: { region: { default: 'eu', choices: ['eu', 'us'] } },
      headers: [{ name: 'Authorization', value: 'Bearer {token}', variables: { token: { isRequired: true, isSecret: true } } }]
    }
  ],
  packages: [
    {
      registryType: 'npm',
      identifier: '@example/github-mcp',
      version: '1.2.0',
      transport: { type: 'stdio' },
      packageArguments: [
        { type: 'positional', value: 'serve' },
        { type: 'named', name: '--root', valueHint: 'root', isRequired: true },
        { type: 'named', name: '--read-only' }
      ],
      environmentVariables: [
        { name: 'GITHUB_TOKEN', isRequired: true, isSecret: true },
        { name: 'LOG_LEVEL', default: 'info' }
      ]
    },
    { registryType: 'pypi', identifier: 'github-mcp', version: '1.2.0' },
    { registryType: 'oci', identifier: 'docker.io/example/github-mcp', version: '1.2.0', environmentVariables: [{ name: 'GITHUB_TOKEN' }] },
    { registryType: 'npm', identifier: 'http-only', transport: { type: 'streamable-http' } },
    { registryType: 'nuget', identifier: 'Example.Github' }
  ]
}

describe('installOptions', () => {
  it('lists the hosted endpoint first and skips what it cannot run', () => {
    expect(installOptions(github).map((option) => option.kind)).toEqual(['remote', 'npm', 'pypi', 'oci'])
  })
})

describe('installFields', () => {
  it('asks for open values and for the variables inside fixed ones', () => {
    const [remote, npm] = installOptions(github)
    expect(installFields(remote).map((item) => item.key)).toEqual(['url/region', 'header/Authorization/token'])
    expect(installFields(npm).map((item) => [item.key, item.required, item.secret])).toEqual([
      ['env/GITHUB_TOKEN', true, true],
      ['env/LOG_LEVEL', false, false],
      ['arg/1', true, false],
      ['arg/2', false, false]
    ])
  })
})

describe('buildServerEntry', () => {
  it('fills a remote url and its headers', () => {
    const [remote] = installOptions(github)
    expect(buildServerEntry(remote, { 'url/region': 'us', 'header/Authorization/token': 'abc' })).toEqual({
      type: 'http',
      url: 'https://api.example.com/us/mcp',
      headers: { Authorization: 'Bearer abc' }
    })
    expect(missingFields(remote, {})).toEqual(['Authorization: token'])
  })

  it('runs an npm package with npx -y, pinned, and leaves empty values out', () => {
    const npm = installOptions(github)[1]
    expect(buildServerEntry(npm, { 'env/GITHUB_TOKEN': ' t ', 'arg/1': '/src' })).toEqual({
      command: 'npx',
      args: ['-y', '@example/github-mcp@1.2.0', 'serve', '--root', '/src'],
      env: { GITHUB_TOKEN: 't', LOG_LEVEL: 'info' }
    })
    expect(missingFields(npm, { 'env/GITHUB_TOKEN': 't' })).toEqual(['--root'])
  })

  it('runs PyPI with uvx and Docker with the env passed through', () => {
    const [, , pypi, oci] = installOptions(github)
    expect(buildServerEntry(pypi, {})).toEqual({ command: 'uvx', args: ['github-mcp@1.2.0'] })
    expect(buildServerEntry(oci, { 'env/GITHUB_TOKEN': 't' })).toEqual({
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'GITHUB_TOKEN', 'docker.io/example/github-mcp:1.2.0'],
      env: { GITHUB_TOKEN: 't' }
    })
  })

  it('makes entries the settings parser accepts', () => {
    const entries = Object.fromEntries(
      installOptions(github).map((option, index) => [`s${index}`, buildServerEntry(option, { 'arg/1': '/x' })])
    )
    expect(Object.keys(parseMcpServers(JSON.stringify(entries)))).toHaveLength(4)
  })
})

describe('suggestServerName', () => {
  it('picks a short free name', () => {
    expect(suggestServerName({ name: 'com.notion/mcp' }, [])).toBe('notion')
    expect(suggestServerName({ name: 'io.github.example/github-mcp' }, ['github'])).toBe('github-2')
    expect(suggestServerName({ name: 'io.github.someone/mcp-server-browser' }, [])).toBe('browser-2')
  })
})

describe('registry search', () => {
  it('splits a query into words on spaces and name separators', () => {
    expect(searchWords('  Meta Ads ')).toEqual(['meta', 'ads'])
    expect(searchWords('meta-ads')).toEqual(['meta', 'ads'])
    expect(searchWords('io.github/meta_ads meta')).toEqual(['io', 'github', 'meta', 'ads'])
    expect(searchWords('   ')).toEqual([])
  })

  it('keeps servers with every word in name, title or description, name and title matches first', () => {
    const servers: RegistryServer[] = [
      { name: 'ai.adsap/adsap', description: 'Launch and manage Meta and Google Ads' },
      { name: 'co.pipeboard/meta-ads-mcp' },
      { name: 'io.github.cesteral/meta-mcp', title: 'Meta Ads MCP Server' },
      { name: 'ai.metabind/docs', description: 'Search the Metabind documentation' },
      { name: 'co.pipeboard/meta-ads-mcp' }
    ]
    expect(rankSearchResults(servers, ['meta', 'ads']).map((server) => server.name)).toEqual([
      'co.pipeboard/meta-ads-mcp',
      'io.github.cesteral/meta-mcp',
      'ai.adsap/adsap'
    ])
  })
})
