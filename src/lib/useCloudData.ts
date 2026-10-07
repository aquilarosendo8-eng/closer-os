import { useCallback, useEffect, useRef, useState } from 'react'
import type { Lead, Settings } from '../types'
import type { WorkspaceAccess } from './access-types'
import { administrationService } from './access'
import { readableError, requireSupabase } from './supabase'
import { validLead, validSettings } from './validation'

interface CloudData {
  leads: Lead[]
  settings: Settings
  owners: Record<string, string>
  members: { userId: string; displayName: string; email: string }[]
}
const emptySettings: Settings = { name: 'Closer', commissionRate: 10, revenueGoal: 200000 }

export function useCloudData(access: WorkspaceAccess | null) {
  const [data, setData] = useState<CloudData>({ leads: [], settings: emptySettings, owners: {}, members: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [loadedScope, setLoadedScope] = useState('')
  const scope = `${access?.workspace.id || ''}:${access?.membership.userId || ''}:${access?.membership.role || ''}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  const workspaceId = access?.workspace.id
  const userId = access?.membership.userId
  const role = access?.membership.role
  const refresh = useCallback(async () => {
    if (!workspaceId || !userId) return
    const requestedScope = `${workspaceId}:${userId}:${role}`
    try {
      const client = requireSupabase()
      const [leadResult, settingsResult, members] = await Promise.all([
        client.from('leads').select('id,owner_id,data').eq('workspace_id', workspaceId).order('created_at', { ascending: false }),
        client.from('workspace_settings').select('name,commission_rate,revenue_goal').eq('workspace_id', workspaceId).single(),
        role === 'admin' || role === 'manager' ? administrationService.listMembers(workspaceId) : Promise.resolve([]),
      ])
      if (leadResult.error) throw leadResult.error
      if (settingsResult.error) throw settingsResult.error
      if (currentScope.current !== requestedScope) return
      const rows = leadResult.data || []
      if (rows.some(row => !validLead(row.data))) throw new Error('Há um registro incompatível no banco. Contate o administrador antes de editar.')
      setData({
        leads: rows.map(row => row.data as Lead),
        owners: Object.fromEntries(rows.map(row => [row.id, row.owner_id])),
        settings: { name: settingsResult.data.name, commissionRate: Number(settingsResult.data.commission_rate), revenueGoal: Number(settingsResult.data.revenue_goal) },
        members: members.filter(row => row.active && row.role !== 'viewer').map(({ userId, displayName, email }) => ({ userId, displayName, email })),
      })
      setLoadedScope(requestedScope)
      setError('')
    } catch (cause) { if (currentScope.current === requestedScope) setError(readableError(cause)) }
    finally { if (currentScope.current === requestedScope) { setLoadedScope(requestedScope); setLoading(false) } }
  }, [workspaceId, userId, role])

  useEffect(() => {
    setData({ leads: [], settings: emptySettings, owners: {}, members: [] }); setError(''); setLoading(Boolean(workspaceId))
    if (!workspaceId) return
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 30000)
    return () => clearInterval(timer)
  }, [scope, refresh, workspaceId])

  const saveLead = async (lead: Lead) => {
    if (!workspaceId || !userId) throw new Error('Selecione uma empresa para continuar.')
    if (!validLead(lead)) throw new Error('Revise os dados do lead antes de salvar.')
    const client = requireSupabase()
    const existing = data.leads.some(item => item.id === lead.id)
    const query = existing
      ? client.from('leads').update({ data: lead }).eq('workspace_id', workspaceId).eq('id', lead.id)
      : client.from('leads').insert({ workspace_id: workspaceId, id: lead.id, owner_id: userId, data: lead })
    const result = await query.select('id').single()
    if (result.error) throw result.error
    if (!result.data) throw new Error('O lead não foi salvo. Seu acesso pode ter sido alterado.')
    await refresh()
  }
  const deleteLead = async (id: string) => {
    if (!workspaceId) throw new Error('Selecione uma empresa para continuar.')
    const { data: removed, error } = await requireSupabase().from('leads').delete().eq('workspace_id', workspaceId).eq('id', id).select('id')
    if (error) throw error
    if (!removed?.length) throw new Error('O lead não foi excluído. Verifique sua permissão.')
    await refresh()
  }
  const saveSettings = async (settings: Settings) => {
    if (!workspaceId || !validSettings(settings)) throw new Error('Informe metas e configurações válidas.')
    const { error } = await requireSupabase().from('workspace_settings').update({ name: settings.name.trim(), commission_rate: settings.commissionRate, revenue_goal: settings.revenueGoal }).eq('workspace_id', workspaceId).select('workspace_id').single()
    if (error) throw error
    await refresh()
  }
  const importLeads = async (leads: Lead[]) => {
    if (!workspaceId || !userId || !leads.every(validLead)) throw new Error('Use um backup válido do Closer OS.')
    let imported = 0, skipped = 0
    try {
      for (let offset = 0; offset < leads.length; offset += 1000) {
        const { data: result, error } = await requireSupabase().rpc('import_leads', { p_workspace_id: workspaceId, p_leads: leads.slice(offset, offset + 1000), p_owner_id: userId })
        if (error) throw error
        imported += Number(result?.imported || 0); skipped += Number(result?.skipped || 0)
      }
    } catch (cause) {
      await refresh()
      throw new Error(`${imported ? `${imported} leads foram importados antes da interrupção. Reimporte para continuar; os IDs existentes serão preservados. ` : ''}${readableError(cause)}`)
    }
    await refresh()
    return { imported, skipped }
  }
  const assignLead = async (leadId: string, ownerId: string) => {
    if (!workspaceId) throw new Error('Selecione uma empresa para continuar.')
    const { error } = await requireSupabase().from('leads').update({ owner_id: ownerId }).eq('workspace_id', workspaceId).eq('id', leadId).select('id').single()
    if (error) throw error
    await refresh()
  }
  const displayed = loadedScope === scope ? data : { leads: [], settings: emptySettings, owners: {}, members: [] }
  return { ...displayed, loading: loading || (Boolean(workspaceId) && loadedScope !== scope), error, refresh, saveLead, deleteLead, saveSettings, importLeads, assignLead }
}
