import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConsistencySection, type DayActivityData } from './components/ConsistencySection'
import {
  type CloudConfig,
  fetchCloudStore,
  loadCloudConfig,
  pushCloudStore,
  saveCloudConfig,
} from './lib/cloudDb'
import {
  type AIGymMachineGuide,
  type DailyCoachResponse,
  analyzeGymMachineWithGemini,
  buildMealComboWithGemini,
  compressImageFileToBase64,
  generateDailyCoachInsight,
  loadCachedCoachInsight,
  loadGeminiKey,
  lookupFoodWithGemini,
  saveGeminiKey,
} from './lib/geminiAi'
import './App.css'

type Food = { id: number; description: string; category: string; energy_kcal?: number | string; protein_g?: number | string; carbohydrate_g?: number | string; lipid_g?: number | string; source?: 'TACO' | 'Estimativa' | 'Mercado Online' | 'IA Gemini'; unitKcal?: number }
type Slot = 'Café / Merenda' | 'Almoço' | 'Pré-Treino' | 'Jantar' | 'Refeição Livre / Lanche' | 'Merenda da Escola' | 'Jantar Único'
type Item = { id: string; foodId: number; name: string; grams: number; kcal?: number; protein?: number; carbs?: number; fat?: number; source?: 'TACO' | 'Estimativa' | 'Mercado Online' | 'IA Gemini' }
type Meal = { id: string; slot: Slot; time: string; date: string; items: Item[] }
type Activity = { id: string; kind: string; date: string; done: boolean; km?: number; minutes?: number; label?: string }
type Measure = { id: string; date: string; weight?: number; bodyFat?: number; muscle?: number; hydration?: number; waist?: number; chest?: number; arm?: number }
type Exercise = { id: string; name: string; sets: Array<{ reps: number; weight: number | null }> }
type Training = { id: string; date: string; group: 'A' | 'B' | 'C'; exercises: Array<{ exerciseId: string; name: string; sets: Array<{ reps: number; weight: number | null }> }> }
type Store = { updatedAt?: number; meals: Meal[]; water: Record<string, number>; activities: Activity[]; comparison: number | null; comparisonConfirmed: boolean; waterReference: number; bottleMl: number; servings: Record<string, number>; creatine: Record<string, boolean>; measures: Measure[]; combos: Array<{ id: string; name: string; items: Array<{ foodId: number; grams: number }> }>; customFoods: Food[]; exercises: Record<'A'|'B'|'C', Exercise[]>; trainings: Training[] }

const KEY = 'kake-pessoal-v2'
const SLOTS: Array<{ name: Slot; time: string }> = [
  { name: 'Merenda da Escola', time: '10:00' },
  { name: 'Almoço', time: '12:00' },
  { name: 'Pré-Treino', time: '16:00' },
  { name: 'Jantar Único', time: '21:00' },
  { name: 'Refeição Livre / Lanche', time: 'Livre' },
]

const initialExercises = (): Store['exercises'] => ({ A: [], B: [], C: [] })
const empty: Store = { updatedAt: 0, meals: [], water: {}, activities: [], comparison: null, comparisonConfirmed: false, waterReference: 3500, bottleMl: 500, servings: { 'Colher de Servir': 60, Concha: 90, Escumadeira: 85, 'Colher de Sopa': 25 }, creatine: {}, measures: [], combos: [], customFoods: [], exercises: initialExercises(), trainings: [] }
const localDate = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const normalizeStore = (data: Partial<Store> | null | undefined): Store => {
  if (!data || typeof data !== 'object') return empty
  return {
    ...empty,
    ...data,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
    meals: Array.isArray(data.meals) ? data.meals : [],
    activities: Array.isArray(data.activities) ? data.activities : [],
    measures: Array.isArray(data.measures) ? data.measures : [],
    combos: Array.isArray(data.combos) ? data.combos : [],
    customFoods: Array.isArray(data.customFoods) ? data.customFoods : [],
    trainings: Array.isArray(data.trainings) ? data.trainings : [],
    exercises: { ...initialExercises(), ...(data.exercises || {}) },
    servings: { ...empty.servings, ...(data.servings || {}) },
    water: data.water && typeof data.water === 'object' ? data.water : {},
    creatine: data.creatine && typeof data.creatine === 'object' ? data.creatine : {},
  }
}
const safeRead = (): Store => { try { const data = JSON.parse(localStorage.getItem(KEY) || 'null'); return normalizeStore(data) } catch { return empty } }
const numeric = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
const format = (value: number, digits = 0) => value.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits })
const norm = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[,;._-]/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim()

const sanitizeNumber = (val: string | number | null | undefined, min = 0, max = 9999): number => {
  if (val === '' || val === null || val === undefined) return min
  const str = String(val).replace(',', '.')
  const parsed = parseFloat(str)
  if (isNaN(parsed) || !Number.isFinite(parsed)) return min
  return Math.min(max, Math.max(min, parsed))
}

const blockInvalidChars = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (['-', '+', 'e', 'E'].includes(e.key)) e.preventDefault()
}

const getCurrentHour = () => new Date().getHours()

const getAutoSlot = (date = new Date()): Slot => {
  const hour = date.getHours()
  if (hour < 11) return 'Merenda da Escola'
  if (hour >= 11 && hour < 15) return 'Almoço'
  if (hour >= 15 && hour < 19) return 'Pré-Treino'
  return 'Jantar Único'
}

const hasAnyUserData = (s: Store): boolean =>
  s.meals.length > 0 ||
  s.activities.length > 0 ||
  s.trainings.length > 0 ||
  s.measures.length > 0 ||
  Object.keys(s.water).length > 0 ||
  Object.keys(s.creatine).length > 0 ||
  s.combos.length > 0 ||
  s.customFoods.length > 0 ||
  s.exercises.A.length > 0 ||
  s.exercises.B.length > 0 ||
  s.exercises.C.length > 0

function App() {
  "use no memo"
  const [store, setStore] = useState<Store>(safeRead)
  const [today] = useState(() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` })
  const [foods, setFoods] = useState<Food[]>([])
  const [page, setPage] = useState<'Hoje' | 'Comida' | 'Movimento' | 'Treinos' | 'Evolução' | 'Avaliação' | 'Rotina' | 'Configurações'>('Hoje')
  const [slot, setSlot] = useState<Slot>(getAutoSlot)
  const [search, setSearch] = useState('')
  const [grams, setGrams] = useState<Record<number, number | ''>>({})
  const [trainingGroup, setTrainingGroup] = useState<'A'|'B'|'C'>('A')
  const [newExercise, setNewExercise] = useState('')
  const [toast, setToast] = useState('')
  const [comparisonInput, setComparisonInput] = useState('')
  const [professionalConfirmed, setProfessionalConfirmed] = useState(false)
  const [bikeDialog, setBikeDialog] = useState(false)
  const [customKm, setCustomKm] = useState('')
  const [customMinutes, setCustomMinutes] = useState('')
  const [customWaterMl, setCustomWaterMl] = useState('')
  const [onlineProducts, setOnlineProducts] = useState<Food[]>([])
  const [onlineLoading, setOnlineLoading] = useState(false)
  const [onlineMessage, setOnlineMessage] = useState('')

  // Cronômetro de Descanso (Treinos)
  const [restSeconds, setRestSeconds] = useState(0)
  const [restTotal, setRestTotal] = useState(90)
  const [restRunning, setRestRunning] = useState(false)

  // Exercício selecionado para o gráfico de progressão (Hevy style)
  const [selectedExerciseName, setSelectedExerciseName] = useState('')

  // Inteligência Artificial (Google Gemini API)
  const [geminiKey, setGeminiKey] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search)
    const magicGemini = params.get('gemini_key')?.trim()
    if (magicGemini) {
      saveGeminiKey(magicGemini)
      return magicGemini
    }
    return loadGeminiKey()
  })
  const [geminiKeyInput, setGeminiKeyInput] = useState(() => geminiKey)
  const [coachInsight, setCoachInsight] = useState<DailyCoachResponse | null>(() => loadCachedCoachInsight(today))
  const [coachLoading, setCoachLoading] = useState(false)
  const [aiFoodLoading, setAiFoodLoading] = useState(false)
  const [aiFoodFeedback, setAiFoodFeedback] = useState('')
  const [comboPrompt, setComboPrompt] = useState('')
  const [comboAiLoading, setComboAiLoading] = useState(false)

  // Assistente de Máquinas e Execução nos Treinos (Câmera + IA + Vídeo)
  const [machineQuery, setMachineQuery] = useState('')
  const [machinePhotoPreview, setMachinePhotoPreview] = useState('')
  const [machineLoading, setMachineLoading] = useState(false)
  const [machineGuide, setMachineGuide] = useState<AIGymMachineGuide | null>(null)

  // Banco de Dados na Nuvem (GitHub Private Repo DB)
  const [cloudCfg, setCloudCfg] = useState<CloudConfig>(() => {
    const params = new URLSearchParams(window.location.search)
    const magicKey = params.get('sync_key')?.trim()
    if (magicKey) {
      const nextCfg: CloudConfig = {
        token: magicKey,
        owner: params.get('sync_owner')?.trim() || 'harthur1234',
        repo: params.get('sync_repo')?.trim() || 'kake-private-db',
        path: 'store.json',
        enabled: true,
      }
      saveCloudConfig(nextCfg)
      return nextCfg
    }
    return loadCloudConfig()
  })
  const [tokenInput, setTokenInput] = useState(() => cloudCfg.token)
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle')
  const [syncMessage, setSyncMessage] = useState('')
  const cloudShaRef = useRef<string | null>(null)
  const pendingPushRef = useRef(false)
  const isPushingRef = useRef(false)
  const storeRef = useRef<Store>(store)

  const notify = (text: string) => setToast(text)

  // Função central para atualizar o Store local e agendar envio para a nuvem
  const updateStore = useCallback((updater: (current: Store) => Store) => {
    pendingPushRef.current = true
    setStore((current) => {
      const next = updater(current)
      return { ...next, updatedAt: Date.now() }
    })
  }, [])

  // Sincronização: Baixar dados da nuvem (Pull)
  const pullFromCloud = useCallback(async (cfg: CloudConfig, silent = false) => {
    if (!cfg.enabled || !cfg.token) return
    setSyncStatus('syncing')
    const result = await fetchCloudStore<Store>(cfg)
    if (result.error) {
      setSyncStatus('error')
      setSyncMessage(result.error)
      if (!silent) notify(result.error)
      return
    }
    if (result.sha) {
      cloudShaRef.current = result.sha
    }
    const remoteStore = result.store ? normalizeStore(result.store) : null
    const localCurrent = storeRef.current

    if (remoteStore) {
      const remoteTime = remoteStore.updatedAt ?? 0
      const localTime = localCurrent.updatedAt ?? 0
      const remoteHasData = hasAnyUserData(remoteStore)
      const localHasData = hasAnyUserData(localCurrent)

      if (remoteHasData && (remoteTime >= localTime || !localHasData)) {
        pendingPushRef.current = false
        setStore(remoteStore)
        setSyncStatus('synced')
        setSyncMessage(`Sincronizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`)
        if (!silent) notify('Dados carregados da nuvem com sucesso!')
      } else if (localHasData && (!remoteHasData || localTime > remoteTime)) {
        // Local tem dados mais novos que a nuvem: envia para a nuvem
        const pushRes = await pushCloudStore(cfg, localCurrent, result.sha)
        if (pushRes.ok) {
          if (pushRes.sha) cloudShaRef.current = pushRes.sha
          setSyncStatus('synced')
          setSyncMessage(`Salvo na nuvem às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`)
        } else {
          setSyncStatus('error')
          setSyncMessage(pushRes.error || 'Erro ao enviar dados')
        }
      } else {
        setSyncStatus('synced')
        setSyncMessage(`Nuvem conectada · ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`)
      }
    } else {
      // Ainda não existe store.json na nuvem, cria com os dados locais
      const pushRes = await pushCloudStore(cfg, localCurrent, null)
      if (pushRes.ok) {
        if (pushRes.sha) cloudShaRef.current = pushRes.sha
        setSyncStatus('synced')
        setSyncMessage('Banco inicializado na nuvem!')
      }
    }
  }, [])

  useEffect(() => {
    storeRef.current = store
  }, [store])

  // Limpa URL se entrou por Link Mágico e faz o primeiro pull da nuvem
  useEffect(() => {
    if (window.location.search.includes('sync_key=') || window.location.search.includes('gemini_key=')) {
      window.history.replaceState({}, document.title, window.location.pathname)
    }
    if (!cloudCfg.enabled || !cloudCfg.token) return
    const timer = window.setTimeout(() => {
      void pullFromCloud(cloudCfg, true)
    }, 50)
    return () => window.clearTimeout(timer)
  }, [cloudCfg, pullFromCloud])

  // Atualiza dados quando o usuário volta para a aba ou desbloqueia o celular
  useEffect(() => {
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible' && cloudCfg.enabled && cloudCfg.token && !pendingPushRef.current) {
        pullFromCloud(cloudCfg, true)
      }
    }
    window.addEventListener('focus', onFocusOrVisible)
    document.addEventListener('visibilitychange', onFocusOrVisible)
    return () => {
      window.removeEventListener('focus', onFocusOrVisible)
      document.removeEventListener('visibilitychange', onFocusOrVisible)
    }
  }, [cloudCfg, pullFromCloud])

  // Salva no localStorage sempre e envia automaticamente para a nuvem (debounce de 900ms + mutex anti-colisão)
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(store))
    } catch {
      console.error('localStorage unavailable or full')
    }
    if (!cloudCfg.enabled || !cloudCfg.token || !pendingPushRef.current) return

    setSyncStatus('syncing')
    const timer = window.setTimeout(async () => {
      if (isPushingRef.current) return
      isPushingRef.current = true
      pendingPushRef.current = false
      try {
        const res = await pushCloudStore(cloudCfg, storeRef.current, cloudShaRef.current)
        if (res.ok) {
          if (res.sha) cloudShaRef.current = res.sha
          setSyncStatus('synced')
          setSyncMessage(`Salvo às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`)
        } else {
          setSyncStatus('error')
          setSyncMessage(res.error || 'Erro ao sincronizar')
        }
      } finally {
        isPushingRef.current = false
      }
    }, 900)

    return () => window.clearTimeout(timer)
  }, [store, cloudCfg])

  useEffect(() => { let cancelled=false; fetch('/data/TACO.json').then((r) => { if (!r.ok) throw new Error('TACO indisponível'); return r.json() }).then((data: Food[]) => { if(!cancelled)setFoods(data) }).catch(() => { if(!cancelled)setToast('Não foi possível carregar data/TACO.json.') }); return ()=>{cancelled=true} }, [])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4000); return () => window.clearTimeout(timer) }, [toast])

  useEffect(() => {
    if (!restRunning || restSeconds <= 0) return
    const timer = window.setInterval(() => {
      setRestSeconds((prev) => {
        if (prev <= 1) {
          setRestRunning(false)
          setToast('Tempo de descanso finalizado! Próxima série.')
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [restRunning, restSeconds])

  const startRestTimer = (seconds: number) => {
    setRestTotal(seconds)
    setRestSeconds(seconds)
    setRestRunning(true)
  }

  const meals = store.meals.filter((meal) => meal.date === today)
  const packagedSeed = useMemo<Food[]>(() => {
    const products: Array<[string, number, number, number, number, number?]> = [
      ['Doritos Queijo Nacho',500,6.8,58,26],['Doritos',510,7,58,27],['Cheetos Requeijão',488,6.4,62,23],['Cheetos',530,6,57,33],['Ruffles Original',540,6,50,35],['Fandangos Presunto',468,6.4,66,19],
      ['Chocolate Bis (Lacta)',506,5.7,63,25],['KitKat 4 Fingers',518,6.5,62,27],['Snickers',488,8.6,60,23],
      ['Whey Protein Concentrado (Growth)',406,76,10,6.6],['Whey Protein 100% (Max Titanium)',393,70,15,5.5],['Barrinha de Proteína (Média)',375,30,38,11],
      ['Pasta de Amendoim Integral',595,28,18,46],['Pão de Forma Tradicional (Pullman)',252,8.6,48,2.6],['Pão de Forma Integral',246,11,41,3.8],
      ['Queijo Mussarela',330,22,3,25],['Queijo Prato',360,23,2,29],['Requeijão Cremoso',257,9.6,3.3,23],['Requeijão Light',173,13,4,12],
      ['Iogurte Natural Integral',61,3.5,4.7,3.3],['Iogurte Grego Tradicional',115,5.2,13,4.8],['Leite Condensado',321,7.8,55,8],
      ['Nescau em Pó',380,3.8,85,2.5],['Toddy em Pó',395,3,88,2.8],['Aveia em Flocos',394,14,67,8.5],
      ['Coca-Cola Normal (por 100ml)',42,0,10.6,0],['Coca-Cola Zero (por 100ml)',0,0,0,0],['Monster Energy (por 100ml)',47,0,12,0],['Monster Energy Zero Ultra (por 100ml)',3,0,0.9,0],['Energético Baly Tradicional (por 100ml)',45,0,11,0],['Energético Baly Zero Açúcar (por 100ml)',0,0,0,0],['Red Bull (por 100ml)',45,0,11,0],
      ['Magic Toast Cacau (por unidade)',11,0.3,2.1,0.1,11],['Batata Frita (Fast Food)',312,3.4,41,15],
    ]
    return products.filter(([name])=>!store.customFoods.some(food=>food.description===name)).map(([name,kcal,protein,carbs,fat,unitKcal],index)=>({id:-1000-index,description:name,category:'Mercado · rótulo padrão',energy_kcal:kcal,protein_g:protein,carbohydrate_g:carbs,lipid_g:fat,source:'Estimativa',unitKcal}))
  }, [store.customFoods])
  const allFoods = useMemo(() => [...store.customFoods, ...packagedSeed, ...onlineProducts, ...foods], [store.customFoods, packagedSeed, onlineProducts, foods])
  const slotMatches = (meal: Meal, target: Slot) => meal.slot === target || (target === 'Merenda da Escola' && meal.slot === 'Café / Merenda') || (target === 'Jantar Único' && meal.slot === 'Jantar')
  const selectedMeal = meals.find((meal) => slotMatches(meal, slot))
  const selectedMealCalories = selectedMeal?.items.reduce((sum, item) => sum + (item.kcal ?? 0), 0) ?? 0
  const activities = store.activities.filter((activity) => activity.date === today)
  const eaten = meals.flatMap((meal) => meal.items)
  const calories = eaten.reduce((sum, item) => sum + (item.kcal ?? 0), 0)
  const protein = eaten.reduce((sum, item) => sum + (item.protein ?? 0), 0)
  const carbsTotal = eaten.reduce((sum, item) => sum + (item.carbs ?? 0), 0)
  const fatTotal = eaten.reduce((sum, item) => sum + (item.fat ?? 0), 0)
  const water = store.water[today] ?? 0
  const comparison = store.comparisonConfirmed && store.comparison !== null ? store.comparison - calories : null
  const query = norm(search)
  const matches = useMemo(() => {
    if (!query) return allFoods.slice(0, 12)
    const terms = query.split(' ').filter(Boolean)
    return allFoods.map((food) => {
      const name = norm(food.description)
      const score = terms.reduce((sum, term) => sum + (name.startsWith(term) ? 3 : name.includes(term) ? 1 : 0), 0)
      return { food, score }
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.food.description.localeCompare(b.food.description, 'pt-BR')).slice(0, 40).map((entry) => entry.food)
  }, [allFoods, query])

  function addFoodDirect(food: Food, amount?: number) {
    const rawGram = grams[food.id]
    const fallbackAmount = rawGram === '' || rawGram === undefined ? (food.unitKcal ? 1 : 100) : rawGram
    const cleanAmount = sanitizeNumber(amount ?? fallbackAmount, 0, 9999)
    if (cleanAmount <= 0) { notify('Informe gramas maiores que zero.'); return }
    const kcal = numeric(food.energy_kcal), proteinBase = numeric(food.protein_g), carbs = numeric(food.carbohydrate_g), fat = numeric(food.lipid_g)
    const item: Item = { id: crypto.randomUUID(), foodId: food.id, name: food.description, grams: cleanAmount, source: food.source ?? 'TACO', ...(kcal === null ? {} : { kcal: food.unitKcal ? food.unitKcal * cleanAmount : kcal * cleanAmount / 100 }), ...(proteinBase === null ? {} : { protein: proteinBase * cleanAmount / 100 }), ...(carbs === null ? {} : { carbs: carbs * cleanAmount / 100 }), ...(fat === null ? {} : { fat: fat * cleanAmount / 100 }) }
    const time = SLOTS.find((entry) => entry.name === slot)?.time ?? 'Livre'
    updateStore((current) => {
      const existing = current.meals.find((meal) => meal.date === today && slotMatches(meal, slot))
      return existing ? { ...current, meals: current.meals.map((meal) => meal.id === existing.id ? { ...meal, items: [...meal.items, item] } : meal) } : { ...current, meals: [...current.meals, { id: crypto.randomUUID(), slot, time: time === 'Livre' ? new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : time, date: today, items: [item] }] }
    })
    notify(`${food.description} (${format(cleanAmount)}g) adicionado em ${slot}!`)
  }

  function addCombo(combo: Store['combos'][number]) {
    const items = combo.items.flatMap((part) => {
      const food = allFoods.find((entry) => entry.id === part.foodId)
      if (!food) return []
      const kcal = numeric(food.energy_kcal), prot = numeric(food.protein_g), carbs=numeric(food.carbohydrate_g),fat=numeric(food.lipid_g)
      return [{ id: crypto.randomUUID(), foodId: food.id, name: food.description, grams: part.grams, ...(kcal === null ? {} : { kcal: food.unitKcal ? food.unitKcal * part.grams : kcal * part.grams / 100 }), ...(prot === null ? {} : { protein: prot * part.grams / 100 }),...(carbs===null?{}:{carbs:carbs*part.grams/100}),...(fat===null?{}:{fat:fat*part.grams/100}) }]
    })
    if (!items.length) { notify('Os alimentos do combo não foram encontrados.'); return }
    const time = SLOTS.find((entry) => entry.name === slot)?.time ?? 'Livre'
    updateStore((current) => { const existing = current.meals.find((meal) => meal.date === today && slotMatches(meal, slot)); return existing ? { ...current, meals: current.meals.map((meal) => meal.id === existing.id ? { ...meal, items: [...meal.items, ...items] } : meal) } : { ...current, meals: [...current.meals, { id: crypto.randomUUID(), slot, time: time === 'Livre' ? new Date().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}) : time, date: today, items }] } })
    notify(`Combo “${combo.name}” adicionado em ${slot}!`)
  }

  function saveCombo() {
    const existing = meals.find((meal) => slotMatches(meal, slot))
    const selected = existing?.items ?? []
    if (selected.length < 1) { notify('Adicione pelo menos um item à refeição antes de salvar o combo.'); return }
    const name = window.prompt('Nome do combo')?.trim()
    if (!name) return
    updateStore((current) => ({ ...current, combos: [...current.combos, { id: crypto.randomUUID(), name, items: selected.map((item) => ({ foodId: item.foodId, grams: item.grams })) }] }))
    notify('Combo salvo e sincronizado.')
  }

  function saveComparison() {
    const value = sanitizeNumber(comparisonInput, 0, 99999)
    if (!professionalConfirmed || value <= 0) { notify('Confirme um valor recomendado por profissional para ativar a comparação.'); return }
    updateStore((current) => ({ ...current, comparison: value, comparisonConfirmed: true }))
    notify('Parâmetro salvo.')
  }

  function streak(predicate: (key: string) => boolean) {
    let count = 0
    const cursor = new Date(`${today}T12:00:00`)
    while (predicate(localDate(cursor))) { count++; cursor.setDate(cursor.getDate() - 1) }
    return count
  }

  const creatineStreak = streak((key) => Boolean(store.creatine[key]))
  const waterStreak = streak((key) => (store.water[key] ?? 0) >= store.waterReference)
  const month = today.slice(0, 7)
  const monthBikes = store.activities.filter((item) => item.kind === 'Bike' && item.date.startsWith(month))
  const monthKm = monthBikes.reduce((sum, item) => sum + (item.km ?? 0), 0)
  const monthWorkouts = store.activities.filter((item) => item.kind === 'Academia' && item.date.startsWith(month) && item.done).length
  const monthWaterDays = Object.entries(store.water).filter(([key]) => key.startsWith(month))
  const waterAverage = monthWaterDays.length ? monthWaterDays.reduce((sum, [, amount]) => sum + amount, 0) / monthWaterDays.length : 0
  const comparisonPrevious = store.measures.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-2)
  const status = water < store.waterReference ? `Faltam ${format(store.waterReference-water)} ml de água para sua referência de hoje` : protein > 0 ? `Você já registrou ${format(protein,1)} g de proteína hoje` : activities.some((item)=>item.kind==='Academia'&&item.done) ? 'Treino registrado · confira suas refeições de hoje' : 'Treino do dia ainda pendente'

  const getActivityForDate = useMemo(() => (dateStr: string): DayActivityData => {
    const dayMeals = store.meals.filter((meal) => meal.date === dateStr)
    const totalKcal = dayMeals.flatMap((meal) => meal.items).reduce((sum, item) => sum + (item.kcal ?? 0), 0)
    const dayActivities = store.activities.filter((activity) => activity.date === dateStr && activity.done)
    return {
      workoutDone: store.trainings.some((training) => training.date === dateStr) || dayActivities.some((activity) => activity.kind === 'Academia'),
      nutritionDone: totalKcal > 0,
      waterDone: (store.water[dateStr] ?? 0) >= store.waterReference,
      bikeDone: dayActivities.some((activity) => activity.kind === 'Bike'),
    }
  }, [store.meals, store.water, store.waterReference, store.activities, store.trainings])

  const streakCount = (() => {
    const hasActivity = (dateStr: string) => {
      const activity = getActivityForDate(dateStr)
      return activity.workoutDone || activity.nutritionDone || activity.waterDone || activity.bikeDone
    }
    let count = 0
    const cursor = new Date(`${today}T12:00:00`)
    while (hasActivity(localDate(cursor))) { count += 1; cursor.setDate(cursor.getDate() - 1) }
    return count
  })()

  // Todos os nomes de exercícios existentes nas fichas e histórico
  const allExerciseNames = useMemo(() => {
    const names = new Set<string>()
    ;(['A', 'B', 'C'] as const).forEach((g) => store.exercises[g].forEach((e) => names.add(e.name)))
    store.trainings.forEach((t) => t.exercises.forEach((e) => names.add(e.name)))
    return Array.from(names)
  }, [store.exercises, store.trainings])

  const activeExerciseName = selectedExerciseName || allExerciseNames[0] || ''

  // Dados do Gráfico de Progressão de Carga e Volume (Hevy style)
  const exerciseProgression = useMemo(() => {
    if (!activeExerciseName) return []
    const points: Array<{ date: string; label: string; maxWeight: number; volume: number }> = []
    const sorted = store.trainings.slice().sort((a, b) => a.date.localeCompare(b.date))
    sorted.forEach((t) => {
      const match = t.exercises.find((e) => norm(e.name) === norm(activeExerciseName))
      if (!match) return
      let maxWeight = 0
      let volume = 0
      match.sets.forEach((s) => {
        const w = s.weight ?? 0
        const r = s.reps ?? 0
        if (w > maxWeight) maxWeight = w
        volume += w * r
      })
      if (maxWeight > 0 || volume > 0) {
        points.push({
          date: t.date,
          label: t.date.slice(5).split('-').reverse().join('/'),
          maxWeight,
          volume,
        })
      }
    })
    return points
  }, [store.trainings, activeExerciseName])

  // Dados dos últimos 7 dias de Nutrição (Calorias e Proteína)
  const last7DaysNutrition = useMemo(() => {
    const base = new Date(`${today}T12:00:00`)
    const labels = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
    return Array.from({ length: 7 }, (_, idx) => {
      const d = new Date(base)
      d.setDate(base.getDate() - (6 - idx))
      const iso = localDate(d)
      const items = store.meals.filter((m) => m.date === iso).flatMap((m) => m.items)
      const kcal = items.reduce((s, i) => s + (i.kcal ?? 0), 0)
      const prot = items.reduce((s, i) => s + (i.protein ?? 0), 0)
      return {
        iso,
        dayLabel: labels[d.getDay()],
        dayNum: d.getDate(),
        kcal,
        prot,
      }
    })
  }, [store.meals, today])

  function saveBike(km: number, minutes: number, label: string) {
    const cleanKm = sanitizeNumber(km, 0, 500)
    const cleanMin = sanitizeNumber(minutes, 0, 999)
    if (cleanKm <= 0) {
      notify('Informe uma distância em km maior que zero.')
      return
    }
    updateStore((current) => ({ ...current, activities: [...current.activities, { id: crypto.randomUUID(), kind: 'Bike', date: today, done: true, km: cleanKm, minutes: cleanMin, label }] }))
    setBikeDialog(false); setCustomKm(''); setCustomMinutes(''); notify(`Pedalada registrada · ${format(cleanKm, 1)} km`)
  }

  function addActivity(kind: string) {
    if (kind === 'Academia' && activities.some((a) => a.kind === 'Academia' && a.done)) {
      notify('Treino na Academia já está registrado hoje!')
      return
    }
    updateStore((current) => ({ ...current, activities: [...current.activities, { id: crypto.randomUUID(), kind, date: today, done: true }] }))
    notify(`${kind} registrado.`)
  }

  function removeMealItem(mealId: string, itemId: string) {
    updateStore((current) => ({ ...current, meals: current.meals.map((meal) => meal.id === mealId ? { ...meal, items: meal.items.filter((item) => item.id !== itemId) } : meal).filter((meal) => meal.items.length) }))
  }

  function addExercise() {
    const name = newExercise.trim()
    if (!name) {
      notify('Digite o nome do exercício para adicionar na ficha.')
      return
    }
    if (store.exercises[trainingGroup].some((e) => norm(e.name) === norm(name))) {
      notify(`"${name}" já está na ficha ${trainingGroup}.`)
      return
    }
    updateStore((current) => ({ ...current, exercises: { ...current.exercises, [trainingGroup]: [...current.exercises[trainingGroup], { id: crypto.randomUUID(), name, sets: [{ reps: 12, weight: null }, { reps: 10, weight: null }, { reps: 8, weight: null }] }] } }))
    setNewExercise(''); notify(`Exercício adicionado à ficha ${trainingGroup}.`)
  }

  function removeExercise(id: string) { updateStore((current) => ({ ...current, exercises: { ...current.exercises, [trainingGroup]: current.exercises[trainingGroup].filter((exercise) => exercise.id !== id) } })) }
  function updateSet(exerciseId: string, setIndex: number, field: 'reps'|'weight', value: number | null) {
    updateStore((current) => ({ ...current, exercises: { ...current.exercises, [trainingGroup]: current.exercises[trainingGroup].map((exercise) => exercise.id === exerciseId ? { ...exercise, sets: exercise.sets.map((set, index) => index === setIndex ? { ...set, [field]: value } : set) } : exercise) } }))
  }
  function addSet(exerciseId: string) {
    updateStore((current) => ({
      ...current,
      exercises: {
        ...current.exercises,
        [trainingGroup]: current.exercises[trainingGroup].map((exercise) =>
          exercise.id === exerciseId && exercise.sets.length < 15
            ? { ...exercise, sets: [...exercise.sets, { reps: 8, weight: null }] }
            : exercise
        ),
      },
    }))
  }
  function removeSet(exerciseId: string) {
    updateStore((current) => ({
      ...current,
      exercises: {
        ...current.exercises,
        [trainingGroup]: current.exercises[trainingGroup].map((exercise) =>
          exercise.id === exerciseId && exercise.sets.length > 1
            ? { ...exercise, sets: exercise.sets.slice(0, -1) }
            : exercise
        ),
      },
    }))
  }

  function finishWorkout() {
    if (store.exercises[trainingGroup].length === 0) {
      notify(`Adicione pelo menos 1 exercício na ficha ${trainingGroup} antes de concluir o treino!`)
      return
    }
    updateStore((current) => {
      const alreadyHasGymActivity = current.activities.some(
        (a) => a.date === today && a.kind === 'Academia' && a.done
      )
      return {
        ...current,
        trainings: [
          ...current.trainings,
          {
            id: crypto.randomUUID(),
            date: today,
            group: trainingGroup,
            exercises: current.exercises[trainingGroup].map((exercise) => ({
              exerciseId: exercise.id,
              name: exercise.name,
              sets: exercise.sets,
            })),
          },
        ],
        activities: alreadyHasGymActivity
          ? current.activities
          : [...current.activities, { id: crypto.randomUUID(), kind: 'Academia', date: today, done: true }],
      }
    })
    notify(`Treino ${trainingGroup} concluído e salvo no histórico!`)
  }

  function saveCustomFood() {
    const name = window.prompt('Nome do alimento/produto')?.trim(); if (!name) return
    const kcal = sanitizeNumber(window.prompt('kcal por 100 g (ou por unidade para Magic Toast)') || 0, 0, 9999)
    const proteinValue = sanitizeNumber(window.prompt('Proteína em g por 100 g (opcional)') || 0, 0, 9999)
    const carbs = sanitizeNumber(window.prompt('Carboidratos em g por 100 g (opcional)') || 0, 0, 9999)
    const fat = sanitizeNumber(window.prompt('Gorduras em g por 100 g (opcional)') || 0, 0, 9999)
    const food: Food = { id: -Date.now(), description: name, category: 'Personalizado · valor informado', energy_kcal: kcal, protein_g: proteinValue, carbohydrate_g: carbs, lipid_g: fat, source: 'Estimativa' }
    updateStore((current) => ({ ...current, customFoods: [...current.customFoods, food] })); setSearch(name); notify('Alimento personalizado salvo.')
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `kake-backup-${today}.json`; a.click(); URL.revokeObjectURL(url); notify('Backup exportado.')
  }
  function importBackup(file?: File) {
    if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const parsed = JSON.parse(String(reader.result)); if (!parsed || !Array.isArray(parsed.meals)) throw new Error('invalid'); updateStore(() => normalizeStore(parsed)); notify('Backup importado e sincronizando.') } catch { notify('Arquivo de backup inválido.') } }; reader.readAsText(file)
  }

  async function searchOpenFoodFacts() {
    const term = search.trim()
    if (term.length < 2) return
    setOnlineLoading(true); setOnlineMessage('Consultando catálogo Open Food Facts Brasil…')
    try {
      const endpoints = [
        `https://br.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(term)}&search_simple=1&action=process&json=1&page_size=12`,
        `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(term)}&country=brazil&search_simple=1&action=process&json=1&page_size=12`
      ]
      let data: { products?: Array<{ product_name?: string; brands?: string; code?: string; nutriments?: Record<string, unknown> }> } | null = null
      for (const url of endpoints) {
        try {
          const res = await fetch(url, { headers: { Accept: 'application/json' } })
          if (res.ok) {
            data = await res.json()
            if (data?.products?.length) break
          }
        } catch {
          // tenta próximo endpoint
        }
      }
      if (!data) throw new Error('Indisponível')
      const products = (data.products ?? []).flatMap((product, index) => {
        const nutriments = product.nutriments ?? {}
        const kcal = numeric(nutriments['energy-kcal_100g'] ?? nutriments['energy-kcal'])
        const proteinValue = numeric(nutriments.proteins_100g ?? nutriments.proteins)
        const carbs = numeric(nutriments.carbohydrates_100g ?? nutriments.carbohydrates)
        const fat = numeric(nutriments.fat_100g ?? nutriments.fat)
        const name = product.product_name?.trim()
        if (!name) return []
        return [{ id: -(50000 + index), description: `${name}${product.brands ? ` (${product.brands.split(',')[0]})` : ''}`, category: `Mercado Online${product.code ? ` · EAN ${product.code}` : ''}`, energy_kcal: kcal ?? undefined, protein_g: proteinValue ?? undefined, carbohydrate_g: carbs ?? undefined, lipid_g: fat ?? undefined, source: 'Mercado Online' as const }]
      })
      setOnlineProducts(products)
      setOnlineMessage(products.length ? `${products.length} produtos encontrados no catálogo online!` : 'Nenhum produto extra encontrado online. Você pode criar um personalizado abaixo.')
    } catch {
      setOnlineMessage('O servidor do Open Food Facts está temporariamente lento. Os produtos de mercado locais já estão inclusos na busca abaixo!')
    } finally { setOnlineLoading(false) }
  }

  function addWater(amount: number) {
    const safeAmount = sanitizeNumber(amount, 0, 5000)
    if (safeAmount <= 0) {
      notify('Informe uma quantidade em ml válida (ex: 300).')
      return
    }
    updateStore((current) => ({ ...current, water: { ...current.water, [today]: Math.min(12000, (current.water[today] ?? 0) + safeAmount) } }))
    notify(`+${safeAmount} ml de água registrados.`)
  }

  async function handleConnectCloud(e: React.FormEvent) {
    e.preventDefault()
    const cleanToken = tokenInput.trim()
    if (!cleanToken) {
      notify('Cole sua Chave de Sincronização (Token) primeiro.')
      return
    }
    const nextCfg: CloudConfig = {
      ...cloudCfg,
      token: cleanToken,
      enabled: true,
    }
    saveCloudConfig(nextCfg)
    setCloudCfg(nextCfg)
    await pullFromCloud(nextCfg, false)
  }

  function handleSaveGeminiKey(e: React.FormEvent) {
    e.preventDefault()
    const clean = geminiKeyInput.trim()
    saveGeminiKey(clean)
    setGeminiKey(clean)
    if (clean) {
      notify('Chave da IA Gemini salva neste dispositivo!')
    } else {
      notify('Chave da IA Gemini removida.')
    }
  }

  async function refreshCoachWithAI() {
    if (!geminiKey) {
      setPage('Configurações')
      notify('Cole sua chave da API Gemini nas Configurações para ativar o Coach IA.')
      return
    }
    setCoachLoading(true)
    try {
      const yesterdayDate = new Date(`${today}T12:00:00`)
      yesterdayDate.setDate(yesterdayDate.getDate() - 1)
      const yesterdayIso = localDate(yesterdayDate)
      const workoutToday =
        store.trainings.some((t) => t.date === today) ||
        activities.some((a) => a.kind === 'Academia' && a.done)
      const workoutYesterday =
        store.trainings.some((t) => t.date === yesterdayIso) ||
        store.activities.some((a) => a.date === yesterdayIso && a.kind === 'Academia' && a.done)
      const sortedTrainings = store.trainings.slice().sort((a, b) => a.date.localeCompare(b.date))
      const lastGroup = sortedTrainings.length > 0 ? sortedTrainings[sortedTrainings.length - 1].group : null
      const nextGroup = lastGroup === 'A' ? 'B' : lastGroup === 'B' ? 'C' : 'A'
      const daysWithKcal = last7DaysNutrition.filter((d) => d.kcal > 0)
      const avg7d =
        daysWithKcal.length > 0
          ? daysWithKcal.reduce((sum, d) => sum + d.kcal, 0) / daysWithKcal.length
          : calories

      const result = await generateDailyCoachInsight(geminiKey, {
        todayDate: today,
        currentHour: getCurrentHour(),
        caloriesToday: calories,
        proteinToday: protein,
        carbsToday: carbsTotal,
        fatToday: fatTotal,
        calorieTarget: store.comparisonConfirmed ? store.comparison : null,
        waterTodayMl: water,
        waterTargetMl: store.waterReference,
        creatineTakenToday: Boolean(store.creatine[today]),
        workoutDoneToday: workoutToday,
        workoutDoneYesterday: workoutYesterday,
        lastWorkoutGroup: lastGroup,
        nextSuggestedGroup: nextGroup,
        streakDays: streakCount,
        mealsCountToday: meals.length,
        avgCaloriesLast7Days: avg7d,
      })
      setCoachInsight(result)
      notify('Coach IA atualizado com base no seu dia!')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Erro ao consultar Coach IA.')
    } finally {
      setCoachLoading(false)
    }
  }

  async function handleAiFoodLookupAndAdd() {
    const queryText = search.trim()
    if (!queryText) {
      notify('Digite o nome do alimento ou bebida na barra de busca primeiro.')
      return
    }
    if (!geminiKey) {
      setPage('Configurações')
      notify('Configure sua chave da API Gemini nas Configurações para pesquisar alimentos com IA.')
      return
    }
    setAiFoodLoading(true)
    setAiFoodFeedback('Gemini IA pesquisando tabela nutricional exata e preparando registro…')
    try {
      const info = await lookupFoodWithGemini(geminiKey, queryText)
      const existingCustom = store.customFoods.find((f) => norm(f.description) === norm(info.description))
      const foodId = existingCustom ? existingCustom.id : -Date.now()
      const newFood: Food = {
        id: foodId,
        description: info.description,
        category: info.category,
        energy_kcal: info.energy_kcal_100g,
        protein_g: info.protein_g_100g,
        carbohydrate_g: info.carbohydrate_g_100g,
        lipid_g: info.lipid_g_100g,
        source: 'IA Gemini',
      }
      const portionGrams = info.suggested_grams
      const itemKcal = (info.energy_kcal_100g * portionGrams) / 100
      const itemProt = (info.protein_g_100g * portionGrams) / 100
      const itemCarbs = (info.carbohydrate_g_100g * portionGrams) / 100
      const itemFat = (info.lipid_g_100g * portionGrams) / 100
      const newItem: Item = {
        id: crypto.randomUUID(),
        foodId,
        name: info.description,
        grams: portionGrams,
        kcal: itemKcal,
        protein: itemProt,
        carbs: itemCarbs,
        fat: itemFat,
        source: 'IA Gemini',
      }
      const time = SLOTS.find((entry) => entry.name === slot)?.time ?? 'Livre'

      updateStore((current) => {
        const nextCustomFoods = existingCustom
          ? current.customFoods.map((f) => (f.id === existingCustom.id ? newFood : f))
          : [newFood, ...current.customFoods]
        const existingMeal = current.meals.find((m) => m.date === today && slotMatches(m, slot))
        const nextMeals = existingMeal
          ? current.meals.map((m) => (m.id === existingMeal.id ? { ...m, items: [...m.items, newItem] } : m))
          : [
              ...current.meals,
              {
                id: crypto.randomUUID(),
                slot,
                time:
                  time === 'Livre'
                    ? new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                    : time,
                date: today,
                items: [newItem],
              },
            ]
        return {
          ...current,
          customFoods: nextCustomFoods,
          meals: nextMeals,
        }
      })

      setAiFoodFeedback(
        `Salvo no banco e adicionado em ${slot}: ${portionGrams}g/ml de ${info.description} (${format(itemKcal)} kcal · P: ${format(itemProt, 1)}g · C: ${format(itemCarbs, 1)}g · G: ${format(itemFat, 1)}g). ${info.note}`
      )
      notify(`${info.description} (${portionGrams}g/ml) cadastrado e adicionado em ${slot}!`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao pesquisar alimento com IA.'
      setAiFoodFeedback(msg)
      notify(msg)
    } finally {
      setAiFoodLoading(false)
    }
  }

  async function handleBuildComboWithAI(alsoLogToMeal: boolean) {
    const command = comboPrompt.trim()
    if (!command) {
      notify('Descreva o combo (ex: 130g de lombo, 100g de arroz e 40g de feijão).')
      return
    }
    if (!geminiKey) {
      setPage('Configurações')
      notify('Configure sua chave da API Gemini nas Configurações para criar combos por comando de IA.')
      return
    }
    setComboAiLoading(true)
    try {
      const result = await buildMealComboWithGemini(geminiKey, command)
      const baseId = Date.now()
      const createdFoods: Food[] = []
      const comboParts: Array<{ foodId: number; grams: number }> = []
      const mealItemsToLog: Item[] = []

      result.items.forEach((part, idx) => {
        const existingCustom = store.customFoods.find((f) => norm(f.description) === norm(part.name))
        const foodId = existingCustom ? existingCustom.id : -(baseId + idx + 1)
        const foodObj: Food = {
          id: foodId,
          description: part.name,
          category: 'IA Gemini · Ingrediente de Combo',
          energy_kcal: part.energy_kcal_100g,
          protein_g: part.protein_g_100g,
          carbohydrate_g: part.carbohydrate_g_100g,
          lipid_g: part.lipid_g_100g,
          source: 'IA Gemini',
        }
        if (!existingCustom) {
          createdFoods.push(foodObj)
        }
        comboParts.push({ foodId, grams: part.grams })
        mealItemsToLog.push({
          id: crypto.randomUUID(),
          foodId,
          name: part.name,
          grams: part.grams,
          kcal: (part.energy_kcal_100g * part.grams) / 100,
          protein: (part.protein_g_100g * part.grams) / 100,
          carbs: (part.carbohydrate_g_100g * part.grams) / 100,
          fat: (part.lipid_g_100g * part.grams) / 100,
          source: 'IA Gemini',
        })
      })

      const newCombo = {
        id: crypto.randomUUID(),
        name: result.comboName,
        items: comboParts,
      }
      const time = SLOTS.find((entry) => entry.name === slot)?.time ?? 'Livre'

      updateStore((current) => {
        const nextCustomFoods = [...createdFoods, ...current.customFoods]
        const nextCombos = [newCombo, ...current.combos]
        if (!alsoLogToMeal) {
          return {
            ...current,
            customFoods: nextCustomFoods,
            combos: nextCombos,
          }
        }
        const existingMeal = current.meals.find((m) => m.date === today && slotMatches(m, slot))
        const nextMeals = existingMeal
          ? current.meals.map((m) =>
              m.id === existingMeal.id ? { ...m, items: [...m.items, ...mealItemsToLog] } : m
            )
          : [
              ...current.meals,
              {
                id: crypto.randomUUID(),
                slot,
                time:
                  time === 'Livre'
                    ? new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                    : time,
                date: today,
                items: mealItemsToLog,
              },
            ]
        return {
          ...current,
          customFoods: nextCustomFoods,
          combos: nextCombos,
          meals: nextMeals,
        }
      })

      setComboPrompt('')
      notify(
        alsoLogToMeal
          ? `Combo "${result.comboName}" criado pela IA e já registrado em ${slot}!`
          : `Combo "${result.comboName}" criado pela IA e salvo para 1 clique!`
      )
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Erro ao criar combo com IA.')
    } finally {
      setComboAiLoading(false)
    }
  }

  async function handleAnalyzeMachineByText(customName?: string) {
    const targetText = (customName ?? machineQuery).trim()
    if (!targetText) {
      notify('Digite o nome da máquina/exercício ou tire uma foto da máquina.')
      return
    }
    setMachineLoading(true)
    if (!customName) setMachinePhotoPreview('')
    try {
      const guide = await analyzeGymMachineWithGemini(geminiKey, targetText)
      setMachineGuide(guide)
      notify(`Guia de execução carregado: ${guide.machineName}`)
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Erro ao consultar guia da máquina.')
    } finally {
      setMachineLoading(false)
    }
  }

  async function handleAnalyzeMachineByPhoto(file?: File) {
    if (!file) return
    setMachineLoading(true)
    try {
      const compressed = await compressImageFileToBase64(file)
      setMachinePhotoPreview(compressed.previewUrl)
      const guide = await analyzeGymMachineWithGemini(geminiKey, machineQuery, {
        mimeType: compressed.mimeType,
        dataB64: compressed.dataB64,
      })
      setMachineGuide(guide)
      notify(`Máquina identificada: ${guide.machineName}!`)
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Não foi possível analisar a foto da máquina.')
    } finally {
      setMachineLoading(false)
    }
  }

  function addMachineToTrainingGroup(name: string, targetGrp: 'A' | 'B' | 'C') {
    if (store.exercises[targetGrp].some((e) => norm(e.name) === norm(name))) {
      setTrainingGroup(targetGrp)
      notify(`"${name}" já está na ficha do Treino ${targetGrp}.`)
      return
    }
    updateStore((current) => ({
      ...current,
      exercises: {
        ...current.exercises,
        [targetGrp]: [
          ...current.exercises[targetGrp],
          {
            id: crypto.randomUUID(),
            name,
            sets: [
              { reps: 12, weight: null },
              { reps: 10, weight: null },
              { reps: 8, weight: null },
            ],
          },
        ],
      },
    }))
    setTrainingGroup(targetGrp)
    notify(`"${name}" adicionado ao Treino ${targetGrp}!`)
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-mark">K</div>
      <div>
        <span className="brand-name">KAKE</span>
        <span className="brand-caption">SEU DIÁRIO PESSOAL</span>
      </div>
      <div className="topbar-right">
        <button
          type="button"
          className={`cloud-status-pill ${cloudCfg.enabled ? `cloud-${syncStatus}` : 'cloud-disconnected'}`}
          onClick={() => {
            if (cloudCfg.enabled && page !== 'Configurações') {
              pullFromCloud(cloudCfg, false)
            } else {
              setPage('Configurações')
            }
          }}
          title={syncMessage || 'Configurar Banco de Dados na Nuvem'}
        >
          <span className="cloud-dot" />
          <span>
            {!cloudCfg.enabled
              ? 'Conectar Nuvem'
              : syncStatus === 'syncing'
              ? 'Sincronizando…'
              : syncStatus === 'error'
              ? 'Erro Nuvem'
              : 'Nuvem Ativa'}
          </span>
        </button>
        <button className={`icon-button ${page === 'Configurações' ? 'active-gear' : ''}`} aria-label="Configurações" title="Configurações" onClick={() => setPage('Configurações')}>⚙</button>
      </div>
    </header>

    <main className="main-content">
      {page === 'Hoje' && <>
        <div className="page-heading">
          <div>
            <div className="eyebrow">{new Date(`${today}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
            <h1>Seu dia, até agora</h1>
          </div>
          <span className="live-dot">● HOJE</span>
        </div>

        {!cloudCfg.enabled && (
          <section className="cloud-banner" onClick={() => setPage('Configurações')}>
            <div>
              <span className="eyebrow">SINCRONIZAÇÃO PC & CELULAR</span>
              <b>Ative o Banco de Dados na Nuvem nas Configurações →</b>
            </div>
          </section>
        )}

        <section className="status-card ai-coach-card">
          <span className="status-mark">{coachInsight ? '✦' : '◷'}</span>
          <div className="coach-copy">
            <div className="coach-header-row">
              <span className="eyebrow">
                {coachInsight ? `COACH IA GEMINI · ${coachInsight.updatedAt}` : 'STATUS DO DIA · SEU DIA ATÉ AGORA'}
              </span>
              <button
                type="button"
                className="coach-ai-btn"
                disabled={coachLoading}
                onClick={refreshCoachWithAI}
              >
                {coachLoading ? 'Analisando dia…' : geminiKey ? '✦ Dica da IA' : '＋ Ativar IA'}
              </button>
            </div>
            <b>{coachInsight ? coachInsight.headline : status}</b>
            {coachInsight ? (
              <small className="coach-advice">{coachInsight.advice}</small>
            ) : (
              <small className="coach-advice">
                {calories > 0
                  ? `Hoje: ${format(calories)} kcal e ${format(protein, 1)}g de proteína acumulados.${store.comparisonConfirmed && store.comparison ? ` Restam ${format(Math.max(0, store.comparison - calories))} kcal para sua referência.` : ''}`
                  : 'Toque em "Dica da IA" para receber recomendações do Gemini com base no seu histórico.'}
              </small>
            )}
          </div>
        </section>

        <ConsistencySection
          currentDateStr={today}
          getActivityForDate={getActivityForDate}
          streakCount={streakCount}
          weeklyGoalTarget={5}
          onSelectDate={(dateStr) => {
            if (dateStr !== today) {
              setPage('Evolução')
              window.scrollTo({ top: 0, behavior: 'instant' })
            }
          }}
        />
        
        {/* Metas & Resumo de Energia e Macros */}
        <section className="card energy-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">ENERGIA & MACROS · HOJE</span>
              <h2>Consumo e movimento</h2>
            </div>
            <span className="icon-orb">↗</span>
          </div>
          <div className="energy-grid">
            <div className="energy-metric">
              <span>Consumido hoje</span>
              <strong>{format(calories)} <small>kcal</small></strong>
            </div>
            <div className="energy-metric">
              <span>Proteína registrada</span>
              <strong>{format(protein, 1)} <small>g</small></strong>
            </div>
          </div>
          <div className="macros-mini-row">
            <span>Carboidratos: <b>{format(carbsTotal, 1)} g</b></span>
            <span>Gorduras: <b>{format(fatTotal, 1)} g</b></span>
          </div>
          {comparison !== null && <div className="comparison-result">
            <div className="row">
              <span>Parâmetro comparativo</span>
              <b>{format(store.comparison!)} kcal</b>
            </div>
            <div className="progress">
              <i style={{ width: `${Math.min(100, calories / store.comparison! * 100)}%` }} />
            </div>
            <div className="row remaining-row">
              <span>Diferença aritmética</span>
              <strong>{format(comparison)} kcal</strong>
            </div>
          </div>}
          <div className="movement-line">
            <span className="movement-icon">⌁</span>
            <span>Movimento registrado</span>
            <strong>{activities.filter((item) => item.done).length} atividades</strong>
          </div>
          <details className="comparison-settings">
            <summary>{comparison === null ? '＋ Configurar parâmetro comparativo' : 'Editar parâmetro comparativo'}</summary>
            <div className="comparison-form">
              <label htmlFor="comparison">Parâmetro numérico (kcal)</label>
              <input id="comparison" type="number" min="0" max="99999" onKeyDown={blockInvalidChars} inputMode="numeric" placeholder="Vazio por padrão" value={comparisonInput || (comparison !== null ? String(store.comparison) : '')} onChange={(event) => setComparisonInput(event.target.value)} />
              <label className="checkline">
                <input type="checkbox" checked={professionalConfirmed} onChange={(event) => setProfessionalConfirmed(event.target.checked)} /> Valor indicado por profissional de saúde.
              </label>
              <div className="form-actions">
                <button className="button-primary compact" onClick={saveComparison}>Salvar</button>
                {comparison !== null && <button className="button-quiet" onClick={() => { updateStore((current) => ({ ...current, comparison: null, comparisonConfirmed: false })); setComparisonInput('') }}>Remover</button>}
              </div>
            </div>
          </details>
        </section>

        {/* Hidratação + Botão Compacto de Creatina no canto superior direito */}
        <section className="card water-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">HIDRATAÇÃO · REGISTRO</span>
              <h2>{format(water / 1000, 2)} <small>/ {format(store.waterReference / 1000, 1)} L ({water} ml)</small></h2>
            </div>
            <div className="water-actions">
              <button
                type="button"
                className={`creatine-pill ${store.creatine[today] ? 'creatine-pill-active' : ''}`}
                aria-pressed={Boolean(store.creatine[today])}
                onClick={() => {
                  const next = !store.creatine[today]
                  updateStore((current) => ({ ...current, creatine: { ...current.creatine, [today]: next } }))
                  notify(next ? 'Creatina 5g marcada hoje!' : 'Creatina desmarcada.')
                }}
              >
                <span className="creatine-check">{store.creatine[today] ? '✓' : ''}</span>
                <span>Creatina 5g</span>
              </button>
            </div>
          </div>
          <div className="progress water-progress">
            <i style={{ width: `${Math.min(100, water / Math.max(store.waterReference, 1) * 100)}%` }} />
          </div>
          <div className="water-controls-grid">
            <button type="button" className="button-primary water-button" onClick={() => addWater(500)}>＋ 500 ml · Garrafinha</button>
            <button type="button" className="button-primary water-button secondary-water" onClick={() => addWater(250)}>＋ 250 ml · Copo</button>
          </div>
          <div className="water-Secondary-row">
            <form className="water-custom-form" onSubmit={(event) => { event.preventDefault(); addWater(Number(customWaterMl)); setCustomWaterMl('') }}>
              <input aria-label="Quantidade personalizada de água em ml" type="number" min="1" max="5000" step="1" placeholder="Outro valor (ml)..." value={customWaterMl} onChange={(event) => setCustomWaterMl(event.target.value)} onKeyDown={blockInvalidChars}/>
              <button className="button-quiet" type="submit">＋ Somar</button>
            </form>
            <button
              type="button"
              className="button-quiet water-correction"
              disabled={water === 0}
              title="Diminuir 250 ml caso tenha clicado por engano"
              onClick={() => {
                updateStore((current) => ({ ...current, water: { ...current.water, [today]: Math.max(0, (current.water[today] ?? 0) - 250) } }))
                notify('−250 ml corrigido.')
              }}
            >
              − 250 ml
            </button>
          </div>
        </section>

        {/* Ações Rápidas */}
        <div className="quick-actions-bar">
          <button className="quick-action-button primary-action" onClick={() => { setSlot(getAutoSlot()); setPage('Comida'); }}>
            <span className="action-icon">＋</span>
            <div className="action-text">
              <b>Registrar alimento</b>
              <small>Auto: {getAutoSlot()}</small>
            </div>
          </button>
          <button className="quick-action-button" onClick={() => setBikeDialog(true)}>
            <span className="action-icon">⌁</span>
            <div className="action-text">
              <b>Pedalada</b>
              <small>{format(activities.filter((item) => item.kind === 'Bike').reduce((sum, item) => sum + (item.km ?? 0), 0), 1)} km hoje</small>
            </div>
          </button>
        </div>

        {/* Lista de Alimentos Consumidos Aberta e Visível */}
        <div className="section-heading">
          <div>
            <span className="eyebrow">ALIMENTOS CONSUMIDOS HOJE</span>
            <h2>Refeições do dia ({eaten.length})</h2>
          </div>
          <button className="button-quiet" onClick={() => { setSlot(getAutoSlot()); setPage('Comida'); }}>+ Adicionar</button>
        </div>

        {meals.length === 0 || eaten.length === 0 ? (
          <section className="card empty-meals-card">
            <p className="empty-state">Nenhum alimento registrado hoje ainda.<br />Toque no botão <b>"Registrar alimento"</b> acima para adicionar seu primeiro consumo.</p>
          </section>
        ) : (
          <div className="meals-feed">
            {meals.map((meal) => (
              <section className="card meal-detail" key={meal.id}>
                <div className="meal-title">
                  <div className="meal-title-group">
                    <span className="meal-tag-pill">{meal.slot}</span>
                    <span className="meal-time-tag">◷ {meal.time}</span>
                  </div>
                  <button className="button-quiet compact" onClick={() => { setSlot(meal.slot); setPage('Comida'); }}>＋ Item</button>
                </div>
                <div className="meal-items-wrap">
                  {meal.items.map((item) => (
                    <div className="food-row detailed-food" key={item.id}>
                      <div className="food-info-block">
                        <div className="food-main-line">
                          <b>{item.name}</b>
                          <span className="grams-pill">{format(item.grams)} g</span>
                        </div>
                        <div className="macro-badge">
                          <span className="macro-kcal"><b>{item.kcal == null ? 'n/d' : `${format(item.kcal)} kcal`}</b></span>
                          <span className="macro-sep">·</span>
                          <span title="Proteínas">P: <b>{item.protein == null ? '0' : format(item.protein, 1)}g</b></span>
                          <span className="macro-sep">·</span>
                          <span title="Carboidratos">C: <b>{item.carbs == null ? '0' : format(item.carbs, 1)}g</b></span>
                          <span className="macro-sep">·</span>
                          <span title="Gorduras">G: <b>{item.fat == null ? '0' : format(item.fat, 1)}g</b></span>
                        </div>
                      </div>
                      <button className="delete-btn" title={`Excluir ${item.name}`} aria-label={`Excluir ${item.name}`} onClick={() => { removeMealItem(meal.id, item.id); notify(`${item.name} removido.`); }}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </>}

      {page === 'Comida' && <>
        <div className="page-heading">
          <div>
            <div className="eyebrow">ADIÇÃO EM 1 CLIQUE · TACO + MERCADO</div>
            <h1>Adicionar alimento</h1>
          </div>
          <span className="badge">{allFoods.length} itens</span>
        </div>

        {/* Tagueamento da Refeição + Resumo Compacto sem Bandeja Gigante */}
        <div className="card slot-card">
          <div className="slot-header-line">
            <span className="eyebrow">REFEIÇÃO DE DESTINO</span>
            <span className="auto-pill">Auto: {getAutoSlot()}</span>
          </div>
          <div className="slot-control-row">
            <select id="meal-slot" className="select-input" value={slot} onChange={(event) => setSlot(event.target.value as Slot)}>
              {SLOTS.map((entry) => <option key={entry.name} value={entry.name}>{entry.name} {entry.time !== 'Livre' ? `(${entry.time})` : ''}</option>)}
            </select>
            <button type="button" className="button-quiet" onClick={() => { const auto = getAutoSlot(); setSlot(auto); notify(`Ajustado para ${auto}`); }}>
              Horário atual
            </button>
          </div>
          <div className="meal-summary-bar">
            <div className="meal-summary-copy">
              <b>{slot}: {selectedMeal?.items.length ?? 0} {(selectedMeal?.items.length ?? 0) === 1 ? 'item' : 'itens'}</b>
              <small>{format(selectedMealCalories)} kcal acumulados nesta refeição hoje</small>
            </div>
            <div className="meal-summary-actions">
              <button type="button" className="button-quiet compact" onClick={saveCombo}>Salvar Combo</button>
              <button type="button" className="button-primary compact" onClick={() => { setPage('Hoje'); window.scrollTo({ top: 0, behavior: 'instant' }) }}>Ver no Dia</button>
            </div>
          </div>
        </div>

        <div className="search-wrap">
          <label className="search-box">
            <span>⌕</span>
            <input aria-label="Buscar alimento" placeholder="Ex: Coca-Cola Zero, Monster, Baly, Arroz, Lombo…" autoComplete="off" value={search} onChange={(event) => setSearch(event.target.value)} />
            {search && <button type="button" className="clear-search" onClick={() => setSearch('')}>×</button>}
          </label>
          {query && <div className="suggestions">{matches.slice(0, 6).map((food) => <button key={food.id} onClick={() => { setSearch(food.description); document.getElementById(`food-${food.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}>{food.description}</button>)}</div>}
        </div>

        {search.trim().length >= 2 && (
          <div className="ai-search-actions">
            <button
              type="button"
              className="ai-lookup-button"
              disabled={aiFoodLoading}
              onClick={handleAiFoodLookupAndAdd}
            >
              {aiFoodLoading
                ? '✦ Gemini IA pesquisando macros e adicionando…'
                : `✦ Pesquisar “${search.trim()}” com Gemini IA, Salvar no Banco e Adicionar em ${slot}`}
            </button>
            <button type="button" className="off-search-button" disabled={onlineLoading} onClick={searchOpenFoodFacts}>
              {onlineLoading ? 'Consultando base Open Food Facts Brasil…' : `＋ Buscar “${search.trim()}” no catálogo Open Food Facts`}
            </button>
          </div>
        )}
        {aiFoodFeedback && <p className="ai-search-feedback" role="status">{aiFoodFeedback}</p>}
        {onlineMessage && <p className="online-search-status" role="status">{onlineMessage}</p>}

        {/* Criador de Combos por Comando de Texto com IA (Estilo MacroFactor AI Describe) */}
        <section className="card ai-combo-builder-card">
          <div className="slot-header-line">
            <span className="eyebrow">CRIADOR DE COMBOS POR TEXTO · GEMINI IA</span>
            <span className="auto-pill">1 Clique</span>
          </div>
          <p className="supporting-text">
            Escreva como você monta seu prato da semana e a IA calcula os macros exatos, cadastra os itens e cria o botão de 1 clique:
          </p>
          <textarea
            className="ai-combo-textarea"
            rows={2}
            placeholder="Ex: Faça um combo novo de Almoço da Semana com 130g de lombo, 100g de arroz e 35g de feijão"
            value={comboPrompt}
            onChange={(e) => setComboPrompt(e.target.value)}
          />
          <div className="ai-combo-actions">
            <button
              type="button"
              className="button-quiet compact"
              disabled={comboAiLoading}
              onClick={() => handleBuildComboWithAI(false)}
            >
              {comboAiLoading ? 'Criando…' : '✦ Só Criar Combo'}
            </button>
            <button
              type="button"
              className="button-primary compact"
              disabled={comboAiLoading}
              onClick={() => handleBuildComboWithAI(true)}
            >
              {comboAiLoading ? 'Processando…' : `✦ Criar e Já Almoçar / Registrar em ${slot}`}
            </button>
          </div>
        </section>

        {/* Combos Salvos com Detalhamento de Ingredientes e Macros */}
        {store.combos.length > 0 && (
          <div className="combo-panel">
            <div className="combo-title">
              <b>Meus combos da semana (Toque para registrar em {slot})</b>
            </div>
            <div className="combo-cards-list">
              {store.combos.map((combo) => {
                let totalKcal = 0
                let totalP = 0
                let totalC = 0
                let totalG = 0
                const partsDesc: string[] = []
                combo.items.forEach((part) => {
                  const f = allFoods.find((entry) => entry.id === part.foodId)
                  if (f) {
                    const k = numeric(f.energy_kcal) ?? 0
                    const p = numeric(f.protein_g) ?? 0
                    const c = numeric(f.carbohydrate_g) ?? 0
                    const g = numeric(f.lipid_g) ?? 0
                    totalKcal += f.unitKcal ? f.unitKcal * part.grams : (k * part.grams) / 100
                    totalP += (p * part.grams) / 100
                    totalC += (c * part.grams) / 100
                    totalG += (g * part.grams) / 100
                    partsDesc.push(`${part.grams}g ${f.description}`)
                  }
                })
                return (
                  <div className="combo-row-card" key={combo.id}>
                    <button type="button" className="combo-main-btn" onClick={() => addCombo(combo)}>
                      <div className="combo-top-line">
                        <b>＋ {combo.name}</b>
                        <span className="combo-kcal-badge">{format(totalKcal)} kcal</span>
                      </div>
                      <small className="combo-ingredients-line">
                        {partsDesc.length > 0 ? partsDesc.join(' + ') : `${combo.items.length} itens`}
                      </small>
                      <small className="combo-macros-line">
                        P: <b>{format(totalP, 1)}g</b> · C: <b>{format(totalC, 1)}g</b> · G: <b>{format(totalG, 1)}g</b> · Toque para lançar em {slot}
                      </small>
                    </button>
                    <button
                      type="button"
                      className="delete-btn"
                      aria-label={`Excluir combo ${combo.name}`}
                      title="Excluir combo"
                      onClick={() =>
                        updateStore((current) => ({
                          ...current,
                          combos: current.combos.filter((x) => x.id !== combo.id),
                        }))
                      }
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <button className="button-quiet full-width" onClick={saveCustomFood}>＋ Cadastrar novo alimento manualmente pelo rótulo</button>

        {/* Lista de Alimentos (TACO + Mercado Local + Online) */}
        <div className="food-list">
          {matches.map((food) => (
            <article className="food-card" id={`food-${food.id}`} key={food.id}>
              <div className="food-copy">
                <b>{food.description}</b>
                <small>{food.category} · {food.source ?? 'TACO'}</small>
                <small>
                  {numeric(food.energy_kcal) === null ? 'Energia n/d' : `${format(numeric(food.energy_kcal)!)} kcal`}
                  {' · '}P: {numeric(food.protein_g) === null ? 'n/d' : `${format(numeric(food.protein_g)!, 1)}g`}
                  {' · '}C: {numeric(food.carbohydrate_g) === null ? 'n/d' : `${format(numeric(food.carbohydrate_g)!, 1)}g`}
                  {' · '}G: {numeric(food.lipid_g) === null ? 'n/d' : `${format(numeric(food.lipid_g)!, 1)}g`}
                  {food.unitKcal ? ' / unid' : ' / 100g'}
                </small>
                <div className="measure-controls">
                  {[-10, 10, 50, 100].map(delta => (
                    <button key={delta} type="button" onClick={() => setGrams(current => ({ ...current, [food.id]: Math.min(9999, Math.max(0, (Number(current[food.id] === '' ? 0 : (current[food.id] ?? 100))) + delta)) }))}>
                      {delta > 0 ? '+' : ''}{delta}g
                    </button>
                  ))}
                  <button type="button" onClick={() => setGrams(current => ({ ...current, [food.id]: 0 }))}>Zerar</button>
                </div>
                <div className="serving-controls">
                  {Object.entries(store.servings).map(([label, amount]) => (
                    <button key={label} type="button" onClick={() => setGrams(current => ({ ...current, [food.id]: Math.min(9999, Math.max(0, (Number(current[food.id] === '' ? 0 : (current[food.id] ?? 100))) + amount)) }))}>
                      +1 {label} (+{amount}g)
                    </button>
                  ))}
                </div>
              </div>
              <div className="food-add">
                <label>
                  <input
                    aria-label={`Gramas de ${food.description}`}
                    type="number"
                    min="0"
                    max="9999"
                    inputMode="decimal"
                    placeholder="100"
                    value={grams[food.id] ?? 100}
                    onKeyDown={blockInvalidChars}
                    onChange={event => {
                      const v = event.target.value
                      setGrams(current => ({ ...current, [food.id]: v === '' ? '' : sanitizeNumber(v, 0, 9999) }))
                    }}
                  />
                  <span>g</span>
                </label>
                <button className="add-food-button" onClick={() => addFoodDirect(food)}>＋ Adicionar</button>
              </div>
            </article>
          ))}
          {!matches.length && <div className="empty-state">Nenhum alimento encontrado localmente. Clique no botão de busca online acima ou crie um personalizado.</div>}
        </div>
      </>}

      {page === 'Movimento' && <>
        <div className="page-heading">
          <div>
            <div className="eyebrow">REGISTRO PESSOAL</div>
            <h1>Movimento</h1>
          </div>
        </div>
        <div className="activity-options">
          {['Academia', 'Educação Física · vôlei', 'Passos · registro manual'].map((kind) => (
            <button key={kind} className="activity-option" onClick={() => addActivity(kind)}>
              <span className="activity-check">＋</span>{kind}
            </button>
          ))}
          <button className="activity-option" onClick={() => setBikeDialog(true)}>
            <span className="activity-check">＋</span>Registrar pedalada
          </button>
        </div>
        <h2 className="subheading">Atividades de hoje</h2>
        {activities.length === 0 && <div className="empty-state">Nenhuma atividade registrada hoje.</div>}
        {activities.map((activity) => (
          <div className="activity-row" key={activity.id}>
            <span className={`check-box ${activity.done ? 'checked' : ''}`}>{activity.done ? '✓' : ''}</span>
            <span>{activity.kind}{activity.label ? ` · ${activity.label}` : ''}{activity.km ? ` · ${format(activity.km, 1)} km` : ''}</span>
          </div>
        ))}
      </>}

      {page === 'Treinos' && <>
        <div className="page-heading">
          <div>
            <div className="eyebrow">FICHAS E PROGRESSÃO DE CARGA</div>
            <h1>Treino {trainingGroup}</h1>
            <p className="supporting-text">{trainingGroup === 'A' ? 'Peito e Bíceps' : trainingGroup === 'B' ? 'Pernas' : 'Costas e Tríceps'}</p>
          </div>
          <button className="button-primary compact" onClick={finishWorkout}>Concluir treino</button>
        </div>

        {/* Cronômetro de Descanso entre Séries */}
        <section className="card rest-timer-card">
          <div className="rest-timer-header">
            <div>
              <span className="eyebrow">CRONÔMETRO DE DESCANSO</span>
              <div className="rest-clock">
                {String(Math.floor(restSeconds / 60)).padStart(2, '0')}:{String(restSeconds % 60).padStart(2, '0')}
                {restRunning && <span className="rest-live-badge">ATIVO</span>}
              </div>
            </div>
            <div className="rest-preset-buttons">
              {[60, 90, 120].map((sec) => (
                <button key={sec} type="button" className="button-quiet compact" onClick={() => startRestTimer(sec)}>
                  {sec}s
                </button>
              ))}
              {restSeconds > 0 && (
                <button type="button" className="button-quiet compact" onClick={() => { setRestRunning(false); setRestSeconds(0) }}>
                  Zerar
                </button>
              )}
            </div>
          </div>
          {restSeconds > 0 && (
            <div className="progress rest-progress">
              <i style={{ width: `${Math.min(100, (restSeconds / Math.max(restTotal, 1)) * 100)}%` }} />
            </div>
          )}
        </section>

        {/* Assistente de Academia IA: Foto da Máquina, Diagrama Biomecânico e Vídeo de Execução */}
        <section className="card machine-ai-card">
          <div className="slot-header-line">
            <span className="eyebrow">AJUDA NA ACADEMIA · CÂMERA & EXECUÇÃO IA</span>
            <span className="auto-pill">Visão + Vídeo</span>
          </div>
          <p className="supporting-text">
            Não conhece uma máquina ou quer conferir a postura correta? Tire uma foto do aparelho na academia ou digite o nome para ver o ajuste do banco, diagrama biomecânico e vídeo de execução:
          </p>
          <div className="machine-ai-controls">
            <label className="camera-upload-btn">
              <span>📷 Tirar Foto da Máquina</span>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void handleAnalyzeMachineByPhoto(f)
                  e.target.value = ''
                }}
              />
            </label>
            <div className="machine-text-search">
              <input
                type="text"
                placeholder="Ou digite a máquina/exercício (ex: Cadeira Extensora, Pulley)…"
                value={machineQuery}
                onChange={(e) => setMachineQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleAnalyzeMachineByText()
                  }
                }}
              />
              <button
                type="button"
                className="button-primary compact"
                disabled={machineLoading}
                onClick={() => void handleAnalyzeMachineByText()}
              >
                {machineLoading ? 'Analisando…' : '✦ Como Usar'}
              </button>
            </div>
          </div>

          {machineLoading && (
            <div className="machine-loading-box">
              <b>✦ Gemini Vision analisando biomecânica e preparando guia visual…</b>
            </div>
          )}

          {machineGuide && !machineLoading && (
            <div className="machine-guide-panel">
              <div className="machine-guide-header">
                <div>
                  <span className="meal-tag-pill">
                    {machineGuide.muscleGroup} · Sugerido: Treino {machineGuide.suggestedGroup}
                  </span>
                  <h3>{machineGuide.machineName}</h3>
                  <small>{machineGuide.targetMuscles}</small>
                </div>
                <button
                  type="button"
                  className="modal-close-inline"
                  title="Fechar guia"
                  onClick={() => {
                    setMachineGuide(null)
                    setMachinePhotoPreview('')
                  }}
                >
                  ×
                </button>
              </div>

              {/* Ilustração Biomecânica Animada (SVG) + Preview da Foto tirada */}
              <div className="machine-visual-grid">
                {machinePhotoPreview && (
                  <div className="machine-photo-box">
                    <img src={machinePhotoPreview} alt={machineGuide.machineName} />
                    <span>Foto analisada pela IA</span>
                  </div>
                )}
                <div className="machine-biomech-box">
                  <svg viewBox="0 0 240 135" className="biomech-svg" role="img" aria-label={`Diagrama biomecânico para ${machineGuide.machineName}`}>
                    <defs>
                      <linearGradient id="muscleGlow" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.95" />
                        <stop offset="100%" stopColor="#2563eb" stopOpacity="0.4" />
                      </linearGradient>
                    </defs>
                    {/* Grade técnica de fundo */}
                    <line x1="20" y1="115" x2="220" y2="115" stroke="#1e2d42" strokeWidth="1.5" />
                    <line x1="120" y1="15" x2="120" y2="115" stroke="#182436" strokeDasharray="3 3" strokeWidth="1" />

                    {/* Silhueta Anatômica + Destaque do Grupo Muscular Alvo */}
                    <circle cx="95" cy="28" r="10" fill="#1e293b" stroke="#64748b" strokeWidth="1.8" />
                    {/* Tronco */}
                    <rect
                      x="83"
                      y="41"
                      width="24"
                      height="38"
                      rx="7"
                      fill={
                        machineGuide.muscleGroup === 'Peito' ||
                        machineGuide.muscleGroup === 'Costas' ||
                        machineGuide.muscleGroup === 'Core'
                          ? 'url(#muscleGlow)'
                          : '#1e293b'
                      }
                      stroke="#60a5fa"
                      strokeWidth="1.5"
                    />
                    {/* Ombros & Braços */}
                    <circle
                      cx="80"
                      cy="46"
                      r="6"
                      fill={machineGuide.muscleGroup === 'Ombros' ? '#3b82f6' : '#334155'}
                    />
                    <path
                      d="M105 46 L138 38 L155 26"
                      fill="none"
                      stroke={
                        machineGuide.muscleGroup === 'Bíceps' ||
                        machineGuide.muscleGroup === 'Tríceps' ||
                        machineGuide.muscleGroup === 'Peito'
                          ? '#60a5fa'
                          : '#64748b'
                      }
                      strokeWidth="5"
                      strokeLinecap="round"
                    />
                    {/* Pernas */}
                    <path
                      d="M90 79 L84 112 M101 79 L118 112"
                      fill="none"
                      stroke={machineGuide.muscleGroup === 'Pernas' ? '#3b82f6' : '#64748b'}
                      strokeWidth="6"
                      strokeLinecap="round"
                    />
                    {/* Vetor de Movimento e Polia/Eixo */}
                    <circle cx="172" cy="48" r="14" fill="#0f172a" stroke="#3b82f6" strokeWidth="2" strokeDasharray="4 2" />
                    <path d="M172 30 L172 66 M166 36 L172 30 L178 36" fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" />
                    <text x="172" y="84" textAnchor="middle" fill="#93c5fd" fontSize="8.5" fontWeight="700">
                      VETOR DE FORÇA
                    </text>
                    <text x="120" y="128" textAnchor="middle" fill="#7f95b0" fontSize="8">
                      Cadência: {machineGuide.cadence}
                    </text>
                  </svg>
                </div>
              </div>

              <div className="machine-steps-block">
                <b>1. Ajuste da Máquina (Setup)</b>
                <ul>
                  {machineGuide.setupTips.map((tip, i) => (
                    <li key={i}>{tip}</li>
                  ))}
                </ul>
              </div>

              <div className="machine-steps-block">
                <b>2. Execução Biomecânica Passo a Passo</b>
                <ol>
                  {machineGuide.executionSteps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </div>

              <div className="machine-steps-block mistakes-block">
                <b>Evite estes erros comuns</b>
                <ul>
                  {machineGuide.commonMistakes.map((errItem, i) => (
                    <li key={i}>{errItem}</li>
                  ))}
                </ul>
              </div>

              <div className="machine-guide-actions">
                <a
                  className="video-watch-btn"
                  href={`https://www.youtube.com/results?search_query=${encodeURIComponent(machineGuide.youtubeSearchQuery)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  ▶ Ver Vídeo de Execução na Prática (YouTube)
                </a>
                <button
                  type="button"
                  className="button-primary compact"
                  onClick={() => addMachineToTrainingGroup(machineGuide.machineName, trainingGroup)}
                >
                  ＋ Adicionar na Ficha {trainingGroup}
                </button>
              </div>
            </div>
          )}
        </section>

        <div className="group-tabs">
          {(['A', 'B', 'C'] as const).map((group) => (
            <button key={group} className={trainingGroup === group ? 'selected' : ''} onClick={() => setTrainingGroup(group)}>
              Treino {group}
              <small>{group === 'A' ? 'Peito e bíceps' : group === 'B' ? 'Pernas' : 'Costas e tríceps'}</small>
            </button>
          ))}
        </div>

        <div className="add-exercise">
          <input
            value={newExercise}
            onChange={event => setNewExercise(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addExercise()
              }
            }}
            placeholder="Adicionar exercício (ex: Supino Reto, Agachamento)..."
          />
          <button className="button-primary compact" onClick={addExercise}>＋ Exercício</button>
        </div>

        {store.exercises[trainingGroup].length === 0 && (
          <div className="empty-state">Sua ficha {trainingGroup} está vazia. Adicione os exercícios acima ou use a câmera IA para identificar máquinas.</div>
        )}

        {store.exercises[trainingGroup].map((exercise) => {
          const previous = store.trainings.slice().reverse().flatMap(training => training.exercises.filter(item => item.exerciseId === exercise.id || norm(item.name) === norm(exercise.name)))
          const allWeights = [
            ...exercise.sets.map(s => s.weight ?? 0),
            ...previous.flatMap(p => p.sets.map(s => s.weight ?? 0))
          ]
          const prWeight = Math.max(0, ...allWeights)
          const currentVolume = exercise.sets.reduce((acc, s) => acc + (s.reps || 0) * (s.weight || 0), 0)

          return (
            <section className="card exercise-card" key={exercise.id}>
              <div className="exercise-heading">
                <div>
                  <h2>{exercise.name}</h2>
                  <div className="exercise-meta-pills">
                    {prWeight > 0 && <span className="pr-badge">PR: {format(prWeight, 1)} kg</span>}
                    {currentVolume > 0 && <span className="vol-badge">Volume: {format(currentVolume)} kg</span>}
                    <button
                      type="button"
                      className="how-to-pill"
                      onClick={() => {
                        setMachineQuery(exercise.name)
                        void handleAnalyzeMachineByText(exercise.name)
                        window.scrollTo({ top: 0, behavior: 'smooth' })
                      }}
                    >
                      ? Como fazer / Vídeo
                    </button>
                  </div>
                </div>
                <button className="remove-button" aria-label={`Excluir ${exercise.name}`} onClick={() => removeExercise(exercise.id)}>×</button>
              </div>
              <div className="sets-head">
                <span>Série</span>
                <span>Reps</span>
                <span>Peso (kg)</span>
              </div>
              {exercise.sets.map((set, index) => (
                <div className="set-row" key={index}>
                  <span>#{index + 1}</span>
                  <input
                    type="number"
                    min="0"
                    max="999"
                    onKeyDown={blockInvalidChars}
                    placeholder="0"
                    value={set.reps === 0 ? '' : set.reps}
                    aria-label={`Série ${index + 1} repetições`}
                    onChange={event => updateSet(exercise.id, index, 'reps', event.target.value === '' ? 0 : sanitizeNumber(event.target.value, 0, 999))}
                  />
                  <input
                    type="number"
                    min="0"
                    max="999"
                    step="0.5"
                    onKeyDown={blockInvalidChars}
                    value={set.weight ?? ''}
                    placeholder="kg"
                    aria-label={`Série ${index + 1} peso kg`}
                    onChange={event => updateSet(exercise.id, index, 'weight', event.target.value === '' ? null : sanitizeNumber(event.target.value, 0, 999))}
                  />
                </div>
              ))}
              <div className="exercise-footer-actions">
                <button className="button-quiet" onClick={() => addSet(exercise.id)}>＋ Série</button>
                {exercise.sets.length > 1 && (
                  <button className="button-quiet" onClick={() => removeSet(exercise.id)}>− Série</button>
                )}
                <button className="button-quiet" onClick={() => startRestTimer(90)}>Descansar 90s</button>
              </div>
              {previous.length > 0 && (
                <div className="load-history">
                  <b>Último registro</b>
                  <small>{previous[0].sets.map((set, index) => `S${index + 1}: ${set.reps}×${set.weight ?? 0}kg`).join(' · ')}</small>
                </div>
              )}
            </section>
          )
        })}
      </>}

      {page === 'Avaliação' && <>
        <div className="page-heading">
          <div>
            <div className="eyebrow">REGISTRO DE MEDIDAS</div>
            <h1>Avaliação física</h1>
          </div>
        </div>
        <form
          className="card assessment-form"
          onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            const next: Measure = {
              id: crypto.randomUUID(),
              date: String(form.get('date') || today),
              weight: sanitizeNumber(String(form.get('weight')), 0, 500) || undefined,
              bodyFat: sanitizeNumber(String(form.get('bodyFat')), 0, 80) || undefined,
              muscle: sanitizeNumber(String(form.get('muscle')), 0, 300) || undefined,
              hydration: sanitizeNumber(String(form.get('hydration')), 0, 100) || undefined,
              waist: sanitizeNumber(String(form.get('waist')), 0, 300) || undefined,
              chest: sanitizeNumber(String(form.get('chest')), 0, 300) || undefined,
              arm: sanitizeNumber(String(form.get('arm')), 0, 150) || undefined,
            }
            const hasAnyMeasure =
              next.weight != null ||
              next.bodyFat != null ||
              next.muscle != null ||
              next.hydration != null ||
              next.waist != null ||
              next.chest != null ||
              next.arm != null
            if (!hasAnyMeasure) {
              notify('Preencha pelo menos uma medida (ex: Peso corporal) antes de salvar.')
              return
            }
            updateStore((current) => ({
              ...current,
              measures: [...current.measures, next].sort((a, b) => a.date.localeCompare(b.date)),
            }))
            notify('Avaliação física salva e sincronizada!')
            event.currentTarget.reset()
          }}
        >
          <label>Data do exame<input type="date" name="date" required defaultValue={today} /></label>
          {([['weight', 'Peso corporal (kg)'], ['bodyFat', 'Gordura corporal (%)'], ['muscle', 'Massa muscular / massa magra (kg)'], ['hydration', 'Hidratação (%)'], ['waist', 'Cintura (cm)'], ['chest', 'Tórax / peitoral (cm)'], ['arm', 'Braço / bíceps (cm)']] as const).map(([key, label]) => (
            <label key={key}>{label}<input type="number" min="0" max="500" step="0.1" name={key} onKeyDown={blockInvalidChars} /></label>
          ))}
          <button className="button-primary">Salvar avaliação</button>
        </form>
        <section className="card">
          <h2>Comparação com a anterior</h2>
          {comparisonPrevious.length < 2 ? (
            <p className="supporting-text">Registre duas avaliações para comparar medidas.</p>
          ) : (
            (() => {
              const [previous, current] = comparisonPrevious
              const labelsMap: Record<string, string> = {
                weight: 'Peso',
                bodyFat: 'Gordura corporal',
                muscle: 'Massa magra',
                hydration: 'Hidratação',
                waist: 'Cintura',
                chest: 'Peitoral',
                arm: 'Braço',
              }
              return (
                <div className="compare-row">
                  {(['weight', 'bodyFat', 'muscle', 'waist', 'chest', 'arm', 'hydration'] as const).map(
                    (key) =>
                      previous[key] != null &&
                      current[key] != null && (
                        <span key={key}>
                          <b>{labelsMap[key]}:</b> {current[key]! - previous[key]! > 0 ? '+' : ''}
                          {format(current[key]! - previous[key]!, 1)}{' '}
                          {key === 'bodyFat' || key === 'hydration'
                            ? 'p.p.'
                            : key === 'weight' || key === 'muscle'
                            ? 'kg'
                            : 'cm'}
                        </span>
                      )
                  )}
                </div>
              )
            })()
          )}
        </section>
      </>}

      {page === 'Evolução' && <>
        <div className="page-heading">
          <div>
            <div className="eyebrow">ANÁLISE DE PERFORMANCE · STRAVA & HEVY</div>
            <h1>Sua evolução</h1>
          </div>
        </div>

        {/* Métricas do Mês */}
        <div className="stats-grid">
          <div className="energy-metric">
            <span>Treinos no mês</span>
            <strong>{monthWorkouts}</strong>
          </div>
          <div className="energy-metric">
            <span>Km de bike no mês</span>
            <strong>{format(monthKm, 1)} <small>km</small></strong>
          </div>
          <div className="energy-metric">
            <span>Média de água</span>
            <strong>{format(waterAverage / 1000, 1)} <small>L/dia</small></strong>
          </div>
          <div className="energy-metric">
            <span>Sequência ativa</span>
            <strong>{streakCount} <small>dias</small></strong>
          </div>
        </div>

        {/* Training Log Estilo Strava (Semana + 28 Dias) */}
        <ConsistencySection
          currentDateStr={today}
          getActivityForDate={getActivityForDate}
          streakCount={streakCount}
          weeklyGoalTarget={5}
        />

        {/* GRÁFICO 1: Progressão de Carga por Exercício (Estilo Hevy) */}
        <section className="card chart-card">
          <div className="chart-header">
            <div>
              <span className="eyebrow">PROGRESSÃO DE CARGA · HEVY</span>
              <h2>Evolução nos Treinos</h2>
            </div>
            {allExerciseNames.length > 0 && (
              <select className="select-input compact-select" value={activeExerciseName} onChange={(e) => setSelectedExerciseName(e.target.value)}>
                {allExerciseNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            )}
          </div>

          {exerciseProgression.length === 0 ? (
            <p className="supporting-text">
              {allExerciseNames.length === 0
                ? 'Cadastre exercícios na aba "Treinos" e clique em "Concluir treino" para gerar o gráfico de progressão de carga.'
                : `Conclua treinos com peso registrado para "${activeExerciseName}" para visualizar a curva de evolução.`}
            </p>
          ) : (() => {
            const maxW = Math.max(...exerciseProgression.map(p => p.maxWeight), 10)
            const width = 320
            const height = 130
            const padX = 28
            const padY = 22
            const coords = exerciseProgression.map((pt, i) => {
              const x = exerciseProgression.length === 1 ? width / 2 : padX + (i / (exerciseProgression.length - 1)) * (width - padX * 2)
              const y = height - padY - (pt.maxWeight / maxW) * (height - padY * 2)
              return { ...pt, x, y }
            })
            const polyline = coords.map(c => `${c.x},${c.y}`).join(' ')
            const area = `${coords[0].x},${height - padY} ${polyline} ${coords[coords.length - 1].x},${height - padY}`

            return (
              <div className="svg-chart-wrap">
                <div className="chart-kpi-row">
                  <span>Maior Carga (PR): <b>{format(maxW, 1)} kg</b></span>
                  <span>Último Volume: <b>{format(exerciseProgression[exerciseProgression.length - 1].volume)} kg</b></span>
                </div>
                <svg viewBox={`0 0 ${width} ${height}`} className="progression-svg">
                  <defs>
                    <linearGradient id="loadGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.4" />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>
                  {coords.length > 1 && <polygon points={area} fill="url(#loadGrad)" />}
                  {coords.length > 1 && <polyline fill="none" stroke="#3b82f6" strokeWidth="2.5" points={polyline} />}
                  {coords.map((c, idx) => (
                    <g key={idx}>
                      <circle cx={c.x} cy={c.y} r="4" fill="#60a5fa" stroke="#0c1118" strokeWidth="1.5" />
                      <text x={c.x} y={c.y - 7} textAnchor="middle" fill="#dce7f5" fontSize="8" fontWeight="700">{c.maxWeight}kg</text>
                      <text x={c.x} y={height - 6} textAnchor="middle" fill="#7f91a8" fontSize="7">{c.label}</text>
                    </g>
                  ))}
                </svg>
              </div>
            )
          })()}
        </section>

        {/* GRÁFICO 2: Consumo de Calorias e Proteínas (Últimos 7 dias) */}
        <section className="card chart-card">
          <div className="chart-header">
            <div>
              <span className="eyebrow">HISTÓRICO NUTRICIONAL · 7 DIAS</span>
              <h2>Calorias & Proteínas</h2>
            </div>
            <span className="auto-pill">Hoje: {format(calories)} kcal</span>
          </div>
          {(() => {
            const maxKcal = Math.max(...last7DaysNutrition.map(d => d.kcal), store.comparison || 2200, 500)
            return (
              <div className="bar-chart-7d">
                {last7DaysNutrition.map((d) => {
                  const pct = Math.min(100, Math.round((d.kcal / maxKcal) * 100))
                  return (
                    <div key={d.iso} className={`bar-col ${d.iso === today ? 'bar-col-today' : ''}`}>
                      <span className="bar-val">{d.kcal > 0 ? format(d.kcal) : '—'}</span>
                      <div className="bar-track">
                        <div className="bar-fill" style={{ height: `${Math.max(pct, d.kcal > 0 ? 8 : 2)}%` }} />
                      </div>
                      <span className="bar-day">{d.dayLabel}</span>
                      <small className="bar-prot">{d.prot > 0 ? `${format(d.prot, 0)}g P` : ''}</small>
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </section>

        {/* GRÁFICO 3: Evolução do Peso Corporal */}
        <section className="card chart-card">
          <div className="chart-header">
            <div>
              <span className="eyebrow">COMPOSIÇÃO CORPORAL</span>
              <h2>Curva de Peso (kg)</h2>
            </div>
            <button className="button-quiet compact" onClick={() => setPage('Avaliação')}>＋ Medida</button>
          </div>
          {store.measures.filter(m => m.weight != null).length === 0 ? (
            <p className="supporting-text">Registre seu peso na aba "Avaliação" para acompanhar o gráfico de composição corporal.</p>
          ) : (() => {
            const pts = store.measures.filter(m => m.weight != null)
            const weights = pts.map(p => p.weight!)
            const minW = Math.min(...weights) - 2
            const maxW = Math.max(...weights) + 2
            const width = 320
            const height = 115
            const padX = 28
            const padY = 20
            const coords = pts.map((p, i) => {
              const x = pts.length === 1 ? width / 2 : padX + (i / (pts.length - 1)) * (width - padX * 2)
              const y = height - padY - ((p.weight! - minW) / Math.max(maxW - minW, 1)) * (height - padY * 2)
              return { ...p, x, y, label: p.date.slice(5).split('-').reverse().join('/') }
            })
            const polyline = coords.map(c => `${c.x},${c.y}`).join(' ')
            return (
              <svg viewBox={`0 0 ${width} ${height}`} className="progression-svg">
                {coords.length > 1 && <polyline fill="none" stroke="#38bdf8" strokeWidth="2.5" points={polyline} />}
                {coords.map((c, idx) => (
                  <g key={idx}>
                    <circle cx={c.x} cy={c.y} r="4" fill="#38bdf8" stroke="#0c1118" strokeWidth="1.5" />
                    <text x={c.x} y={c.y - 7} textAnchor="middle" fill="#e0f2fe" fontSize="8" fontWeight="700">{format(c.weight!, 1)}kg</text>
                    <text x={c.x} y={height - 5} textAnchor="middle" fill="#7f91a8" fontSize="7">{c.label}</text>
                  </g>
                ))}
              </svg>
            )
          })()}
        </section>

        {/* Conquistas */}
        <section className="card">
          <h2>Conquistas do mês</h2>
          <div className="badge-grid">
            {[['medal', 'Semana de Ferro', '4 treinos no mês', monthWorkouts >= 4], ['drop', 'Mestre da Água', '5 dias batendo a meta', waterStreak >= 5], ['bolt', 'Velocista da Bike', '40 km pedalados', monthKm >= 40], ['capsule', 'Hábito Sagrado', '7 dias de creatina', creatineStreak >= 7]].map(([icon, name, detail, unlocked]) => (
              <div className={`badge-item ${unlocked ? 'unlocked' : ''}`} key={String(name)}>
                <span className="svg-badge">
                  {icon === 'medal' ? <svg viewBox="0 0 24 24"><path d="M8 3h8l3 5-7 5-7-5 3-5Z" /><circle cx="12" cy="15" r="6" /></svg> : icon === 'drop' ? <svg viewBox="0 0 24 24"><path d="M12 3s7 7 7 12a7 7 0 1 1-14 0c0-5 7-12 7-12Z" /></svg> : icon === 'bolt' ? <svg viewBox="0 0 24 24"><path d="m13 2-9 12h7l-1 8 10-13h-7z" /></svg> : <svg viewBox="0 0 24 24"><path d="M4 8a4 4 0 0 1 4-4h8a4 4 0 0 1 0 8H8a4 4 0 0 1-4-4Z" /></svg>}
                </span>
                <b>{name}</b>
                <small>{detail}</small>
                <em>{unlocked ? 'Desbloqueado' : 'Em andamento'}</em>
              </div>
            ))}
          </div>
        </section>
      </>}

      {page === 'Rotina' && <>
        <div className="page-heading">
          <div>
            <div className="eyebrow">PLANEJADOR DIÁRIO DE HÁBITOS</div>
            <h1>Sua rotina de hoje</h1>
          </div>
          <button className="button-quiet compact" onClick={() => setPage('Configurações')}>⚙ Ajustes</button>
        </div>
        {[
          {
            title: 'Manhã (06:00 — 11:00)',
            checks: [
              ['Aula / Deslocamento matinal', activities.some(a => a.date === today && a.done && (a.kind === 'Bike' || a.kind.includes('Passos')))],
              ['Merenda / Café da manhã registrado', meals.some(m => slotMatches(m, 'Merenda da Escola'))],
              ['Primeira garrafinha de água (500ml+)', water >= 500],
            ],
          },
          {
            title: 'Meio-dia (11:00 — 14:30)',
            checks: [
              ['Almoço completo registrado', meals.some(m => m.slot === 'Almoço')],
              ['Metade da meta de água (1,7L+)', water >= store.waterReference / 2],
            ],
          },
          {
            title: 'Tarde (15:00 — 18:30)',
            checks: [
              ['Lanche Pré-Treino consumido', meals.some(m => m.slot === 'Pré-Treino')],
              ['Treino na Academia concluído', store.trainings.some(t => t.date === today) || activities.some(a => a.date === today && a.done && a.kind === 'Academia')],
              ['Pedalada registrada', activities.some(a => a.date === today && a.done && a.kind === 'Bike')],
            ],
          },
          {
            title: 'Noite (19:00 — 23:00)',
            checks: [
              ['Jantar registrado', meals.some(m => slotMatches(m, 'Jantar Único'))],
              ['Creatina 5g marcada', Boolean(store.creatine[today])],
              ['Meta total de hidratação batida', water >= store.waterReference],
            ],
          },
        ].map((block) => (
          <section className="card routine-block" key={block.title}>
            <h2>{block.title}</h2>
            <div className="routine-list">
              {block.checks.map(([label, done]) => (
                <div className="routine-row" key={String(label)}>
                  <span>{label}</span>
                  <span className={`routine-status ${done ? 'routine-done' : ''}`}>{done ? '✓ Concluído' : 'Pendente'}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </>}

      {page === 'Configurações' && <>
        <div className="page-heading">
          <div>
            <div className="eyebrow">PREFERÊNCIAS & NUVEM</div>
            <h1>Configurações</h1>
          </div>
          <button className="button-quiet compact" onClick={() => setPage('Hoje')}>Voltar</button>
        </div>

        {/* INTEGRAÇÃO AUTOMÁTICA DE NUVEM & IA GEMINI (SEM EXPOR CHAVES NA TELA) */}
        <section className="card cloud-db-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">SISTEMA INTEGRADO · PC & CELULAR</span>
              <h2>Nuvem & Inteligência Artificial</h2>
            </div>
            <span className="cloud-badge cloud-badge-on">ATIVO</span>
          </div>
          <p className="supporting-text">
            O seu <b>Banco de Dados na Nuvem ({cloudCfg.owner}/{cloudCfg.repo})</b> e a <b>IA Google Gemini 3.5</b> já estão integrados diretamente no projeto principal. Qualquer dispositivo que abrir o aplicativo já sincroniza e usa a IA automaticamente.
          </p>

          {syncMessage && <p className="cloud-sync-feedback">{syncMessage}</p>}

          <div className="cloud-actions-grid">
            <button type="button" className="button-quiet" onClick={() => pullFromCloud(cloudCfg, false)}>
              ↻ Baixar da Nuvem agora
            </button>
            <button
              type="button"
              className="button-quiet"
              onClick={async () => {
                setSyncStatus('syncing')
                const res = await pushCloudStore(cloudCfg, store, cloudShaRef.current)
                if (res.ok) {
                  if (res.sha) cloudShaRef.current = res.sha
                  setSyncStatus('synced')
                  setSyncMessage(`Enviado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`)
                  notify('Dados deste aparelho enviados para a nuvem!')
                } else {
                  setSyncStatus('error')
                  notify(res.error || 'Erro ao enviar')
                }
              }}
            >
              ↑ Salvar na Nuvem agora
            </button>
          </div>

          <details className="comparison-settings">
            <summary>Opções avançadas de chaves (oculto por padrão)</summary>
            <form className="cloud-form" onSubmit={handleSaveGeminiKey}>
              <label className="field-label" htmlFor="gemini-token">Substituir chave Gemini (opcional)</label>
              <div className="cloud-input-row">
                <input
                  id="gemini-token"
                  type="password"
                  autoComplete="off"
                  placeholder="Chave integrada ativa"
                  value={geminiKeyInput}
                  onChange={(e) => setGeminiKeyInput(e.target.value)}
                />
                <button type="submit" className="button-quiet compact">Salvar</button>
              </div>
            </form>
            <form className="cloud-form" onSubmit={handleConnectCloud}>
              <label className="field-label" htmlFor="cloud-token">Substituir chave GitHub (opcional)</label>
              <div className="cloud-input-row">
                <input
                  id="cloud-token"
                  type="password"
                  autoComplete="off"
                  placeholder="Chave integrada ativa"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
                <button type="submit" className="button-quiet compact">Salvar</button>
              </div>
            </form>
          </details>
        </section>

        <section className="card setting-card">
          <h2>Backup em arquivo (JSON)</h2>
          <p className="supporting-text">Exporte uma cópia manual ou restaure um arquivo JSON salvo anteriormente.</p>
          <div className="settings-actions">
            <button className="button-primary compact" onClick={exportBackup}>Exportar backup</button>
            <label className="button-quiet import-button">
              Importar JSON
              <input type="file" accept="application/json,.json" onChange={event => importBackup(event.target.files?.[0])} />
            </label>
          </div>
        </section>
        <section className="card setting-card">
          <h2>Alimentos e combos salvos</h2>
          <p className="supporting-text">{store.combos.length} combos · {store.customFoods.length} alimentos personalizados</p>
          {store.combos.map(combo => (
            <div className="manage-row" key={combo.id}>
              <span>{combo.name}</span>
              <button className="remove-button" onClick={() => updateStore(current => ({ ...current, combos: current.combos.filter(item => item.id !== combo.id) }))}>Excluir</button>
            </div>
          ))}
          {store.customFoods.map(food => (
            <div className="manage-row" key={food.id}>
              <span>{food.description}</span>
              <button className="remove-button" onClick={() => updateStore(current => ({ ...current, customFoods: current.customFoods.filter(item => item.id !== food.id) }))}>Excluir</button>
            </div>
          ))}
        </section>
        <section className="card setting-card">
          <h2>Medidas caseiras e hidratação</h2>
          {Object.entries(store.servings).map(([name, value]) => (
            <label className="setting-input-row" key={name}>
              {name}
              <input type="number" min="0" max="9999" onKeyDown={blockInvalidChars} value={value} onChange={event => updateStore(current => ({ ...current, servings: { ...current.servings, [name]: sanitizeNumber(event.target.value, 1, 9999) } }))} /> g
            </label>
          ))}
          <label className="setting-input-row">
            Meta diária de água (ml)
            <input type="number" min="500" max="10000" step="100" onKeyDown={blockInvalidChars} value={store.waterReference} onChange={event => updateStore(current => ({ ...current, waterReference: sanitizeNumber(event.target.value, 500, 10000) }))} /> ml
          </label>
          <label className="setting-input-row">
            Tamanho da garrafa (ml)
            <input type="number" min="50" max="5000" onKeyDown={blockInvalidChars} value={store.bottleMl} onChange={event => updateStore(current => ({ ...current, bottleMl: sanitizeNumber(event.target.value, 50, 5000) }))} /> ml
          </label>
        </section>
        <section className="card setting-card">
          <h2>Armazenamento local</h2>
          <p className="supporting-text">Limpar os dados apenas deste navegador.</p>
          <button className="button-quiet" onClick={() => { if (window.confirm('Apagar todos os registros locais deste navegador?')) { localStorage.removeItem(KEY); setStore(empty); notify('Registros locais apagados.') } }}>Apagar meus dados locais</button>
        </section>
        <section className="card setting-card">
          <h2>Fontes de Dados</h2>
          <p className="supporting-text">Tabela Brasileira de Composição de Alimentos (TACO / UNICAMP) e Open Food Facts Brasil.</p>
          <a className="source-link" href="/data/TACO-LICENSE" target="_blank" rel="noreferrer">Ver licença MIT</a>
        </section>
      </>}
    </main>

    <nav className="bottom-nav" aria-label="Navegação principal">
      {(['Hoje', 'Comida', 'Treinos', 'Movimento', 'Evolução', 'Avaliação', 'Rotina'] as const).map((item) => (
        <button
          key={item}
          className={page === item ? 'active' : ''}
          onClick={() => {
            if (item === 'Comida') setSlot(getAutoSlot())
            setPage(item)
            window.scrollTo({ top: 0, behavior: 'instant' })
          }}
        >
          <span>{item === 'Hoje' ? '⌂' : item === 'Comida' ? '◉' : item === 'Treinos' ? '▤' : item === 'Movimento' ? '⌁' : item === 'Evolução' ? '▦' : item === 'Avaliação' ? '◍' : '◷'}</span>
          {item}
        </button>
      ))}
    </nav>

    {bikeDialog && (
      <div className="modal-backdrop" onClick={() => setBikeDialog(false)}>
        <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="bike-title" onClick={(event) => event.stopPropagation()}>
          <button className="modal-close" onClick={() => setBikeDialog(false)}>×</button>
          <span className="eyebrow">REGISTRAR PEDALADA</span>
          <h2 id="bike-title">Qual foi o trajeto?</h2>
          {[['Casa ↔ Escola', 3.5], ['Casa ↔ Academia', 6], ['Casa / Tia → Academia', 1.5]].map(([label, km]) => (
            <button className="route-button" key={label} onClick={() => saveBike(Number(km), 0, String(label))}>
              <span>{label}</span>
              <b>{format(Number(km), 1)} km</b>
            </button>
          ))}
          <div className="custom-route">
            <label>Trajeto livre</label>
            <div className="route-inputs">
              <input type="number" min="0" max="500" step="0.1" onKeyDown={blockInvalidChars} placeholder="km (ex: 4.5)" value={customKm} onChange={(event) => setCustomKm(event.target.value)} />
              <input type="number" min="0" max="999" onKeyDown={blockInvalidChars} placeholder="min (opcional)" value={customMinutes} onChange={(event) => setCustomMinutes(event.target.value)} />
            </div>
            <button className="button-primary" onClick={() => sanitizeNumber(customKm, 0, 500) > 0 ? saveBike(Number(customKm), sanitizeNumber(customMinutes, 0, 999), 'Trajeto livre') : notify('Informe uma distância em km maior que zero.')}>Salvar trajeto</button>
          </div>
        </section>
      </div>
    )}

    {toast && (
      <div className="toast" role="status">
        {toast}
        <button aria-label="Fechar" onClick={() => setToast('')}>×</button>
      </div>
    )}
    <footer className="app-footer">PRIVADO NESTE DISPOSITIVO & NUVEM PESSOAL · TACO & OPEN FOOD FACTS BR</footer>
  </div>
}

export default App
