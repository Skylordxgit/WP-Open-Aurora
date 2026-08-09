export function OmegaBilling() {
  return (
    <div className="omega-page">
      <div className="omega-page-actions">
        <div>
          <h2>Billing</h2>
          <p>Placeholder for the future SaaS billing workflow inside the OpenWA admin dashboard.</p>
        </div>
        <span className="omega-badge neutral">Placeholder</span>
      </div>

      <section className="omega-grid omega-grid-two">
        <article className="omega-card">
          <div className="omega-card-header">
            <div>
              <h2>Current State</h2>
              <p>The billing area is reserved for subscription collection, invoice history, and payment provider sync.</p>
            </div>
          </div>
          <p className="omega-empty">
            No separate Omega admin frontend is being restored. This placeholder keeps billing inside the primary OpenWA
            admin panel at <code>/</code>.
          </p>
        </article>

        <article className="omega-card">
          <div className="omega-card-header">
            <div>
              <h2>Planned Scope</h2>
              <p>When billing is implemented, it should stay aligned with the merged SaaS admin structure.</p>
            </div>
          </div>
          <div className="omega-definition-list">
            <div>
              <dt>Admin Surface</dt>
              <dd>/</dd>
            </div>
            <div>
              <dt>Client Portal</dt>
              <dd>/app</dd>
            </div>
            <div>
              <dt>Backend APIs</dt>
              <dd>/api/omega</dd>
            </div>
          </div>
        </article>
      </section>
    </div>
  );
}
