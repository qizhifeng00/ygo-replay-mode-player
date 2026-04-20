/**
 * Lua 脚本持久缓存
 * 使用 IndexedDB 存储脚本，避免每次刷新都重新下载
 */

const DB_NAME = 'ygo-script-cache'
const DB_VERSION = 8
const STORE_NAME = 'scripts'
const METADATA_STORE = 'metadata'

const SCRIPT_CACHE_VERSION = '1.0.4'

let db: IDBDatabase | null = null
let dbReady = false
let dbInitPromise: Promise<boolean> | null = null

// 内存缓存（快速访问）
const memoryCache = new Map<string, Uint8Array>()

/**
 * 初始化 IndexedDB
 */
export async function initScriptCache(): Promise<boolean> {
  if (dbReady) return true
  if (dbInitPromise) return dbInitPromise

  dbInitPromise = new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => {
        console.warn('[ScriptCache] IndexedDB 不可用，使用内存缓存')
        resolve(false)
      }

      request.onsuccess = () => {
        db = request.result
        dbReady = true
        console.log('[ScriptCache] IndexedDB 初始化成功')
        resolve(true)
      }

      request.onupgradeneeded = event => {
        const database = (event.target as IDBOpenDBRequest).result
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
        if (!database.objectStoreNames.contains(METADATA_STORE)) {
          database.createObjectStore(METADATA_STORE, { keyPath: 'key' })
        }
      }
    } catch (e) {
      console.warn('[ScriptCache] IndexedDB 初始化失败:', e)
      resolve(false)
    }
  })

  return dbInitPromise
}

/**
 * 从缓存获取脚本
 */
export async function getScript(key: string): Promise<Uint8Array | null> {
  // 先检查内存缓存
  if (memoryCache.has(key)) {
    return memoryCache.get(key)!
  }

  // 尝试从 IndexedDB 获取
  if (!dbReady || !db) return null

  return new Promise(resolve => {
    try {
      const transaction = db!.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(key)

      request.onsuccess = () => {
        if (request.result?.data) {
          const data = new Uint8Array(request.result.data)
          memoryCache.set(key, data) // 加入内存缓存
          resolve(data)
        } else {
          resolve(null)
        }
      }

      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/**
 * 同步获取脚本（仅从内存缓存）
 */
export function getScriptSync(key: string): Uint8Array | null {
  return memoryCache.get(key) || null
}

/**
 * 保存脚本到缓存
 */
export async function setScript(key: string, data: Uint8Array, timestamp?: number): Promise<void> {
  // 存入内存缓存
  memoryCache.set(key, data)

  // 存入 IndexedDB
  if (!dbReady || !db) return

  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.put({
      key,
      data: Array.from(data),
      timestamp: timestamp || Date.now(),
      version: SCRIPT_CACHE_VERSION
    })
  } catch (e) {
    console.warn('[ScriptCache] 保存失败:', key, e)
  }
}

/**
 * 检查脚本是否在缓存中
 */
export function hasScript(key: string): boolean {
  return memoryCache.has(key)
}

/**
 * 获取缓存大小
 */
export function getCacheSize(): number {
  return memoryCache.size
}

/**
 * 预加载脚本到内存缓存（从 IndexedDB 批量加载）
 */
export async function preloadToMemory(): Promise<number> {
  if (!dbReady || !db) return 0

  return new Promise(resolve => {
    try {
      const transaction = db!.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.getAll()

      request.onsuccess = () => {
        const items = request.result || []
        for (const item of items) {
          if (item.key && item.data) {
            memoryCache.set(item.key, new Uint8Array(item.data))
          }
        }
        console.log(`[ScriptCache] 从 IndexedDB 加载了 ${items.length} 个脚本`)
        resolve(items.length)
      }

      request.onerror = () => resolve(0)
    } catch {
      resolve(0)
    }
  })
}

/**
 * 清空缓存
 */
export async function clearCache(): Promise<void> {
  memoryCache.clear()

  if (!dbReady || !db) return

  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.clear()
    console.log('[ScriptCache] 缓存已清空')
  } catch (e) {
    console.warn('[ScriptCache] 清空失败:', e)
  }
}

/**
 * 获取缓存统计信息
 */
export function getCacheStats() {
  let totalSize = 0
  memoryCache.forEach(data => {
    totalSize += data.length
  })

  return {
    count: memoryCache.size,
    sizeKB: Math.round(totalSize / 1024),
    sizeMB: (totalSize / 1024 / 1024).toFixed(2),
  }
}

/**
 * 获取脚本的缓存时间戳
 */
export async function getScriptTimestamp(key: string): Promise<number | null> {
  if (!dbReady || !db) return null

  return new Promise(resolve => {
    try {
      const transaction = db!.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(key)

      request.onsuccess = () => {
        resolve(request.result?.timestamp || null)
      }

      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/**
 * 检查缓存版本，如果版本不匹配则清空缓存
 */
export async function checkCacheVersion(): Promise<boolean> {
  if (!dbReady || !db) return false

  return new Promise(resolve => {
    try {
      const transaction = db!.transaction(METADATA_STORE, 'readwrite')
      const store = transaction.objectStore(METADATA_STORE)
      const request = store.get('version')

      request.onsuccess = async () => {
        const storedVersion = request.result?.value

        if (storedVersion !== SCRIPT_CACHE_VERSION) {
          console.log(`[ScriptCache] 版本变更 (${storedVersion} → ${SCRIPT_CACHE_VERSION})，清空缓存`)
          await clearCache()

          // 保存新版本
          const updateTransaction = db!.transaction(METADATA_STORE, 'readwrite')
          const updateStore = updateTransaction.objectStore(METADATA_STORE)
          updateStore.put({ key: 'version', value: SCRIPT_CACHE_VERSION })

          resolve(true)
        } else {
          resolve(false)
        }
      }

      request.onerror = () => {
        // 首次使用，保存版本
        store.put({ key: 'version', value: SCRIPT_CACHE_VERSION })
        resolve(false)
      }
    } catch (e) {
      console.warn('[ScriptCache] 版本检查失败:', e)
      resolve(false)
    }
  })
}

/**
 * 强制更新指定脚本（删除缓存，强制重新下载）
 */
export async function forceUpdateScript(key: string): Promise<void> {
  memoryCache.delete(key)

  if (!dbReady || !db) return

  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.delete(key)
    console.log('[ScriptCache] 已删除缓存:', key)
  } catch (e) {
    console.warn('[ScriptCache] 删除失败:', key, e)
  }
}
