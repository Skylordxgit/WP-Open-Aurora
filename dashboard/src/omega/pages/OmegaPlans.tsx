import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { omegaApi } from '../api';

export function OmegaPlans() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['omega-plans'], queryFn: omegaApi.plans });
  const [form, setForm] = useState({
    name: '',
    description: '',
    monthlyMessageLimit: 10000,
    whatsappAccountLimit: 1,
    monthlyPrice: 49,
    features: '',
  });

  const mutation = useMutation({
    mutationFn: () =>
      omegaApi.createPlan({
        ...form,
        features: form.features
          .split(',')
          .map(item => item.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      setForm({ name: '', description: '', monthlyMessageLimit: 10000, whatsappAccountLimit: 1, monthlyPrice: 49, features: '' });
      void queryClient.invalidateQueries({ queryKey: ['omega-plans'] });
    },
  });

  if (isLoading) return <div className="omega-card">Loading plans...</div>;
  if (error) return <div className="omega-inline-error">{(error as Error).message}</div>;

  return (
    <div className="omega-page">
      <section className="omega-grid omega-grid-two">
        <article className="omega-card">
          <div className="omega-card-header">
            <div>
              <h2>Plans Management</h2>
              <p>Set per-client message ceilings and WhatsApp account allocation rules.</p>
            </div>
          </div>
          <div className="omega-plan-grid">
            {data!.map(plan => (
              <div key={plan.id} className="omega-plan-card">
                <div className="omega-stack-inline">
                  <strong>{plan.name}</strong>
                  <span className={`omega-badge ${plan.isActive ? 'success' : 'neutral'}`}>{plan.isActive ? 'active' : 'inactive'}</span>
                </div>
                <p>{plan.description}</p>
                <h3>${plan.monthlyPrice}/mo</h3>
                <ul>
                  <li>{plan.monthlyMessageLimit.toLocaleString()} monthly messages</li>
                  <li>{plan.whatsappAccountLimit} WhatsApp accounts</li>
                  <li>{plan.activeClients ?? 0} active clients</li>
                </ul>
              </div>
            ))}
          </div>
        </article>

        <article className="omega-card">
          <h2>Create Plan</h2>
          <form
            className="omega-form"
            onSubmit={event => {
              event.preventDefault();
              mutation.mutate();
            }}
          >
            <label><span>Name</span><input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
            <label><span>Description</span><textarea value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
            <label><span>Monthly Message Limit</span><input type="number" value={form.monthlyMessageLimit} onChange={event => setForm({ ...form, monthlyMessageLimit: Number(event.target.value) })} /></label>
            <label><span>WhatsApp Account Limit</span><input type="number" value={form.whatsappAccountLimit} onChange={event => setForm({ ...form, whatsappAccountLimit: Number(event.target.value) })} /></label>
            <label><span>Monthly Price</span><input type="number" value={form.monthlyPrice} onChange={event => setForm({ ...form, monthlyPrice: Number(event.target.value) })} /></label>
            <label><span>Features (comma separated)</span><textarea value={form.features} onChange={event => setForm({ ...form, features: event.target.value })} /></label>
            {mutation.error && <div className="omega-inline-error">{(mutation.error as Error).message}</div>}
            <button className="omega-primary-button" type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Creating...' : 'Create Plan'}
            </button>
          </form>
        </article>
      </section>
    </div>
  );
}
