export function AboutPage() {
  return (
    <section className="panel about-panel">
      <h2>About AhinLendor</h2>
      <div className="about-content">
        <section>
          <h3>What is AhinLendor?</h3>
          <p>
            AhinLendor is an AI for the board game <strong>Splendor</strong>, built using a complete{' '}
            <strong>AlphaZero-style</strong> architecture. It learns entirely through self-play,
            combining a policy-value neural network with Monte Carlo Tree Search (MCTS)
            to discover strategies without any human game data.
          </p>
          <p>
            In live competition, AhinLendor reached <strong>Rank 1</strong> on the{' '}
            <a href="https://spendee.mattle.online/" target="_blank" rel="noreferrer">spendee.mattle.online</a>
            {' '}leaderboard. It has also won exhibition matches against two of the <strong>top-ranked human players</strong> on{' '}
            <a href="https://boardgamearena.com/" target="_blank" rel="noreferrer">BoardGameArena</a>:{' '}
            <strong>seed seed (zuroti)</strong> and <strong>FourDimensional</strong>.
          </p>
          <img src="/leaderboard-rank1.png" alt="AhinLendor leaderboard rank 1" className="about-image" />
        </section>
        <section>
          <h3>Specifications</h3>
          <p>
            When AhinLendor reached <strong>Rank 1</strong> on Spendee, it competed under a{' '}
            <strong>5 minutes + 10 seconds per action</strong> time control. For each move, the engine performed{' '}
            <strong>70,000 MCTS simulations</strong>.
          </p>
          <p>
            Later versions improved the search with <strong>250,000 MCTS simlulations</strong>,{' '}
            <strong>20,000 bootstrap iterations</strong>, and batching <strong>64 leaf evaluations</strong> at a time.
            On a MacBook M2, this version took about <strong>20 seconds per move</strong>.
          </p>
        </section>
        <section>
          <h3>Reducing the Action Space</h3>
          <p>
            One of the first design challenges was defining the <strong>action space</strong>, the set of actions the
            AI can choose from at each move. In Splendor, token collection and returns create many valid
            combinations, and treating every card as a separate buy or reserve action quickly inflates the policy
            space. For example, Jonatan Simonsson&apos;s master&apos;s thesis, <em>Creating an AI Opponent with Super-Human
            Performance for Splendor</em>, uses <strong>371 possible actions</strong>.
          </p>
          <p>
            AhinLendor greatly reduces this action space through several design choices. When
            returning tokens, the AI chooses <strong>one token at a time</strong> in a separate return phase instead
            of selecting an entire return combination at once, dramatically reducing the number of actions. Buy and
            reserve actions are also limited to the cards currently available on the board (<strong>12 buy actions</strong>{' '}
            and <strong>15 reserve actions</strong>). Together, these design choices reduce the policy space to{' '}
            <strong>69 actions</strong> while preserving the full game rules.
          </p>
        </section>
        <section>
          <h3>Bootstrap Search</h3>
          <p>
            A weakness emerged while analyzing games against <strong>seed seed</strong>, the former Rank 1 player on
            BoardGameArena. <strong>seed seed</strong> favored <strong>long-term</strong> engine-building plans, while
            AhinLendor often preferred moves that looked immediately stronger. In one game, the human correctly
            identified that buying an unassuming <strong>Tier 1</strong> card early would determine the outcome many
            turns later, but the AI largely ignored it.
          </p>
          <p>
            The problem came from the value network. Because <strong>MCTS</strong> naturally focuses on moves that
            already appear promising, actions that are initially underestimated receive very little exploration.
            <strong>Bootstrap MCTS</strong> addresses this by performing a fixed number of simulations from every
            legal move one ply ahead before normal tree search begins. This gives each candidate meaningful
            exploration before standard MCTS allocates simulations according to its search policy.
          </p>
        </section>
        <section>
          <h3>Developer Notes</h3>
          <p>
            Reaching <strong>Rank 1</strong> on Spendee initially suggested that AhinLendor had reached a
            <strong>superhuman</strong> level of play. That assumption changed after playing against seed seed, who
            narrowly won their first match <strong>4-3</strong> despite the engine&apos;s top ranking. Later versions won
            the rematch <strong>6-0</strong>, but those games showed that achieving the highest online rating does
            not mean every strategic weakness has been solved.
          </p>
          <p>
            Splendor&apos;s <strong>stochastic card reveals</strong> make evaluation harder than in
            <strong>perfect-information</strong> games. Even the objectively best move can become worse if an
            unfavorable card appears afterward, so the <strong>value function</strong> can never be perfectly
            accurate. Deeper search can compensate, but <strong>neural-network inference</strong> remains the
            computational bottleneck. An <strong>NNUE-style evaluator</strong> could enable much deeper search and may
            reduce some remaining weaknesses.
          </p>
          <p>
            Another open problem is reasoning about an opponent&apos;s <strong>hidden reserved card</strong>. The current
            engine samples a random unseen card during each <strong>MCTS simulation</strong>, which is unbiased but does
            not model clues from the opponent&apos;s gem collection or long-term plan. An explicit <strong>belief model</strong>
            over hidden cards remains a future research direction.
          </p>
        </section>
      </div>
    </section>
  );
}
