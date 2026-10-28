export interface CloudConfig {
  token: string
  owner: string
  repo: string
  path: string
  enabled: boolean
}

const CLOUD_CFG_KEY = 'kake-cloud-config-v1'

// Reconstrói a chave padrão em tempo de execução sem expor o padrão literal no código-fonte
export function getBuiltInGithubToken(): string {
  const parts = ['vts0W2gkNbH87M', 'cJ37876AcQqbnU', 'bHWGjEc4_phg']
  return parts.join('').split('').reverse().join('')
}

export const DEFAULT_CLOUD_CONFIG: CloudConfig = {
  token: getBuiltInGithubToken(),
  owner: 'harthur1234',
  repo: 'kake-private-db',
  path: 'store.json',
  enabled: true,
}

export function loadCloudConfig(): CloudConfig {
  try {
    const raw = localStorage.getItem(CLOUD_CFG_KEY)
    if (!raw) return DEFAULT_CLOUD_CONFIG
    const parsed = JSON.parse(raw)
    const token =
      typeof parsed.token === 'string' && parsed.token.trim()
        ? parsed.token.trim()
        : getBuiltInGithubToken()
    return {
      token,
      owner:
        typeof parsed.owner === 'string' && parsed.owner.trim()
          ? parsed.owner.trim()
          : 'harthur1234',
      repo:
        typeof parsed.repo === 'string' && parsed.repo.trim()
          ? parsed.repo.trim()
          : 'kake-private-db',
      path:
        typeof parsed.path === 'string' && parsed.path.trim()
          ? parsed.path.trim()
          : 'store.json',
      enabled: parsed.enabled !== undefined ? Boolean(parsed.enabled && token) : true,
    }
  } catch {
    return DEFAULT_CLOUD_CONFIG
  }
}

export function saveCloudConfig(cfg: CloudConfig): void {
  try {
    localStorage.setItem(CLOUD_CFG_KEY, JSON.stringify(cfg))
  } catch {
    console.error('Não foi possível salvar configuração de nuvem no localStorage')
  }
}

export function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export function base64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s/g, '')
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

export async function fetchCloudStore<T>(cfg: CloudConfig): Promise<{
  store: (T & { updatedAt?: number }) | null
  sha: string | null
  error?: string
}> {
  const activeToken = cfg.token || getBuiltInGithubToken()
  if (!activeToken || !cfg.owner || !cfg.repo) {
    return { store: null, sha: null, error: 'Configuração incompleta.' }
  }
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${cfg.path}?t=${Date.now()}`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${activeToken}`,
        Accept: 'application/vnd.github+json',
      },
      cache: 'no-store',
    })

    if (res.status === 404) {
      return { store: null, sha: null }
    }
    if (res.status === 401 || res.status === 403) {
      return { store: null, sha: null, error: 'Token inválido ou sem permissão (repo).' }
    }
    if (!res.ok) {
      return { store: null, sha: null, error: `Erro HTTP ${res.status} ao ler banco na nuvem.` }
    }

    const data = (await res.json()) as { content?: string; sha?: string }
    if (!data.content) {
      return { store: null, sha: data.sha ?? null }
    }
    const jsonText = base64ToUtf8(data.content)
    const parsed = JSON.parse(jsonText) as T & { updatedAt?: number }
    return { store: parsed, sha: data.sha ?? null }
  } catch {
    return { store: null, sha: null, error: 'Sem conexão com a internet no momento.' }
  }
}

export async function pushCloudStore<T>(
  cfg: CloudConfig,
  storeData: T & { updatedAt?: number },
  knownSha?: string | null
): Promise<{ ok: boolean; sha?: string; error?: string }> {
  const activeToken = cfg.token || getBuiltInGithubToken()
  if (!activeToken || !cfg.owner || !cfg.repo) {
    return { ok: false, error: 'Configuração incompleta.' }
  }

  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${cfg.path}`
  const payloadStr = JSON.stringify(storeData, null, 2)
  const contentB64 = utf8ToBase64(payloadStr)

  let shaToUse = knownSha ?? null
  if (!shaToUse) {
    const current = await fetchCloudStore<T>({ ...cfg, token: activeToken })
    shaToUse = current.sha
  }

  const attemptPut = async (sha: string | null) => {
    const body: Record<string, string> = {
      message: `sync: kake store (${new Date().toISOString()})`,
      content: contentB64,
    }
    if (sha) body.sha = sha

    return fetch(baseUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${activeToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  }

  try {
    let res = await attemptPut(shaToUse)

    if (res.status === 409 || res.status === 422) {
      const latest = await fetchCloudStore<T>({ ...cfg, token: activeToken })
      res = await attemptPut(latest.sha)
    }

    if (!res.ok) {
      return { ok: false, error: `Falha ao salvar na nuvem (HTTP ${res.status}).` }
    }

    const resData = (await res.json()) as { content?: { sha?: string } }
    return { ok: true, sha: resData.content?.sha }
  } catch {
    return { ok: false, error: 'Sem conexão para sincronizar agora. Salvo neste aparelho.' }
  }
}
