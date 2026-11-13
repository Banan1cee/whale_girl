namespace WhaleLauncher
{
    internal sealed class PageOperationLifetime
    {
        private long _generation;
        private bool _active;
        public void Activate() { _generation++; _active = true; }
        public void Deactivate() { _generation++; _active = false; }
        public long Capture() => _generation;
        public bool IsCurrent(long generation) => _active && generation == _generation;
    }

    internal sealed class PageOperation
    {
        internal readonly struct Ticket
        {
            public readonly long Generation;
            public readonly long Revision;
            public Ticket(long generation, long revision) { Generation = generation; Revision = revision; }
        }
        private readonly PageOperationLifetime _lifetime;
        private long _revision;
        public PageOperation(PageOperationLifetime lifetime) { _lifetime = lifetime; }
        public void Invalidate() => _revision++;
        public Ticket Begin() { Invalidate(); return new Ticket(_lifetime.Capture(), _revision); }
        public bool IsCurrent(Ticket ticket)
            => _lifetime.IsCurrent(ticket.Generation) && ticket.Revision == _revision;
    }
}
