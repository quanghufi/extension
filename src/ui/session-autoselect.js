(() => {
    function scoreSession(session) {
        const stateRank = {
            running: 4,
            pending: 3,
            completed: 2,
            partial_completion: 2,
            failed: 1,
            cancelled: 0,
        };

        const createdAt = Date.parse(session.createdAt || 0);
        return {
            stateScore: stateRank[session.state] ?? -1,
            createdAt,
        };
    }

    window.pickBestSession = function pickBestSession(sessions) {
        if (!Array.isArray(sessions) || sessions.length === 0) return null;

        return [...sessions].sort((left, right) => {
            const a = scoreSession(left);
            const b = scoreSession(right);
            if (b.stateScore !== a.stateScore) return b.stateScore - a.stateScore;
            return b.createdAt - a.createdAt;
        })[0] ?? null;
    };
})();
