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
            <a href="https://boardgamearena.com/" target="_blank" rel="noreferrer">Board Game Arena</a>:{' '}
            <strong>seed seed (Zuroti)</strong> and <strong>FourDimensional</strong>.
          </p>
          <img src="/leaderboard-rank1.png" alt="AhinLendor leaderboard rank 1" className="about-image" />
          <img src="/bga-ranking.png" alt="BGA Ranking" className="about-image" />
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
            reserve actions are also limited to the cards currently available on the board. Together, these design choices reduce the policy space to{' '}
            <strong>69 actions</strong> while preserving the full game rules.
          </p>
          <img src="/action-space.jpeg" alt="AhinLendor action space" className="about-image" />
        </section>
        <section>
          <h3>Bootstrap Search</h3>
          <p>
            A weakness emerged while analyzing games against <strong>seed seed</strong>, the former Rank 1 player on Board Game Arena.
            Consider the position below—it is AhinLendor's turn to move. What would you play?
          </p>
          <img src="/example-match.png" alt="AhinLendor vs seed seed" className="about-image" />
          <p>
            AhinLendor chose to collect gems. However, <strong>seed seed</strong> immediately recognized that
            <strong> reserving the 2/1 green card was the critical move</strong>. While unassuming on its own, this card opens an efficient path
            into powerful follow-up purchases such as the <strong>4-point 7 and 5-point 7/3 red cards</strong>. 
            Early in the game, AhinLendor failed to appreciate its strategic importance, and as the game progressed,
            its predicted chance of winning steadily declined.
          </p>
          <p>
            The issue lay in the interaction between the value network and MCTS. Since MCTS naturally spends most of its simulations on moves
            that already appear promising, actions with low initial network evaluations receive very little exploration. In this position,
            reserving the 2/1 green card was initially scored poorly by the neural network, so MCTS rarely searched that line—even though a
            small amount of additional search would have revealed it to be the strongest move.
          </p>
          
          <img src="/top-moves-2.png" alt="AI Top Moves" className="about-image about-image-compact" />

          <p>
            To overcome this limitation, I designed <strong>Bootstrap MCTS</strong>, a search enhancement built on top of standard MCTS. 
            Instead of immediately following the neural network's initial evaluations, Bootstrap MCTS first <strong> performs a fixed number of simulations
            from every legal move one ply ahead</strong>. Only then does normal MCTS begin allocating simulations according to its search policy.
            This allows the search to exploit promising moves that may have been initially underestimated by the neural network.
          </p>

          <p>
            <strong>After this change, the engine correctly evaluated reserving the 2/1 green card as the best move.</strong>
          </p>

          <img src="/top-moves-3.png" alt="AI Top Moves" className="about-image about-image-compact" />


        </section>
        <section>
          <h3>Developer Notes</h3>
          <p>
            Splendor's <strong>stochastic card reveals</strong> make evaluation significantly harder than in {" "}
            <strong>perfect-information</strong> games. Even the objectively best move can become suboptimal
            if an unfavorable card is revealed afterward, meaning the <strong>value function</strong> can never
            be perfectly accurate. While deeper search can compensate for this uncertainty,
            {" "} <strong>neural-network inference</strong> remains the primary computational bottleneck.
            One question I am interested in exploring is whether an <strong>NNUE-style evaluator</strong> {" "}
            could enable significantly deeper search while maintaining comparable evaluation quality.
          </p>
          <p>
            Another open problem is reasoning about an opponent's <strong>hidden reserved card</strong>.
            The current engine samples a random unseen card during each <strong>MCTS simulation</strong>,
            which is unbiased but ignores information revealed by the opponent's behavior. For example,
            if an opponent has a <strong>face-down Tier 3 reserve</strong> and begins aggressively collecting
            {" "} <strong>red gems</strong>, an experienced human may infer that the hidden card is likely one of
            the expensive red-heavy Tier 3 cards, such as the <strong>7-point</strong> card.
            The current engine does not make this kind of inference, instead treating every unseen card as equally likely.
            An explicit <strong>belief model</strong> that updates the probability distribution over hidden cards
            based on observed actions remains a possible direction for future research.
          </p>
        </section>
      </div>
    </section>
  );
}
