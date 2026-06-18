'use client';

import { useEffect, useState, useCallback } from 'react';

export default function TenantSettingsPage() {
  const [maxConcurrentGuarantees, setMaxConcurrentGuarantees] = useState<number>(3);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      // Use your configured API utility in practice; raw fetch used here for simplicity
      const res = await fetch('/api/v1/tenants/settings', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
          'X-Tenant-ID': localStorage.getItem('tenantId') || '',
        }
      });
      
      if (!res.ok) throw new Error('Failed to fetch settings');
      
      const json = await res.json();
      if (json.maxConcurrentGuarantees) {
        setMaxConcurrentGuarantees(json.maxConcurrentGuarantees);
      }
    } catch (error) {
      console.error(error);
      setMessage({ text: 'Failed to load configuration.', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch('/api/v1/tenants/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('accessToken')}`,
          'X-Tenant-ID': localStorage.getItem('tenantId') || '',
        },
        body: JSON.stringify({ maxConcurrentGuarantees: Number(maxConcurrentGuarantees) }),
      });

      if (!res.ok) throw new Error('Failed to update settings');
      
      setMessage({ text: 'Tenant settings successfully updated.', type: 'success' });
    } catch (error) {
      console.error(error);
      setMessage({ text: 'Error saving settings.', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-gray-500 animate-pulse">Loading settings...</div>;
  }

  return (
    <div className="p-8 max-w-2xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100 mt-8">
      <h1 className="text-2xl font-bold mb-6 text-gray-900">Tenant Configuration</h1>
      
      {message && (
        <div className={`p-4 mb-6 rounded-md text-sm font-medium ${message.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
          {message.text}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        <div>
          <label htmlFor="maxGuarantees" className="block text-sm font-semibold text-gray-700 mb-2">
            Maximum Concurrent Guarantees
          </label>
          <input type="number" id="maxGuarantees" min="1" step="1" required value={maxConcurrentGuarantees} onChange={(e) => setMaxConcurrentGuarantees(parseInt(e.target.value, 10))} className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:bg-white transition-all outline-none" />
          <p className="mt-2 text-sm text-gray-500">Limits the number of active loans a single member can guarantee at the same time within this SACCO.</p>
        </div>

        <div className="flex justify-end pt-4 border-t border-gray-100">
          <button type="submit" disabled={saving} className="px-6 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-70 transition-colors shadow-sm">
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </form>
    </div>
  );
}