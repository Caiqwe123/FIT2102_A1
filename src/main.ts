/**
 * Inside this file you will use the classes and functions from rx.js
 * to add visuals to the svg element in index.html, animate them, and make them interactive.
 *
 * Study and complete the tasks in observable exercises first to get ideas.
 *
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 *
 * You will be marked on your functional programming style
 * as well as the functionality that you implement.
 *
 * Document your code!
 */

import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    map,
    scan,
    switchMap,
    take,
    merge,
    startWith,
    timer,
} from "rxjs";
import { fromFetch } from "rxjs/fetch";

/** Constants */

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
} as const;

const Birb = {
    WIDTH: 42,
    HEIGHT: 30,
} as const;

const Constants = {
    PIPE_WIDTH: 50,
    TICK_RATE_MS: 50, // Might need to change this!
    GRAVITY: 1, // Gravity constant
    GROUND: 400, // Ground level
    CEILING: 0, // Ceiling level
    SEED: 1234, // Random seed
    JUMP_SPEED: -5,
    PIPE_SPEED: 8,
} as const;

abstract class RNG {
    private static m = 0x80000000; // 2^31
    private static a = 1103515245;
    private static c = 12345;

    public static hash = (seed: number): number =>
        (RNG.a * seed + RNG.c) % RNG.m;

    public static scale = (hash: number): number =>
        (2 * hash) / (RNG.m - 1) - 1; // in [-1, 1]
}

// User input

type Key = "Space";

// Pipes
type Pipe = {
    gapY: number;
    gapHeight: number;
    delay: number;
    x: number;
};

type Box = {
    x: number;
    y: number;
    width: number;
    height: number;
};

// State processing

type State = Readonly<{
    gameEnd: boolean; // game end flag
    gameStart: boolean; // game start flag
    gamePause: boolean; // game pause flag
    position: number; // y-coordinate of the bird
    velocity: number; // vertical velocity of the bird
    lives: number; // number of remaining lives
    seed: number; // random seed
    score: number; // current score
    resume: boolean; // resume flag
    fullScore: number;
    pipes: Pipe[]; // array of pipes
    all_pipes: Pipe[];
    time: number;
    pause: boolean;
}>;

const initialState: State = {
    gameEnd: false, // game ends or not
    gameStart: false, // game has started or not
    gamePause: false,
    position: Constants.GROUND / 2, // begins with bird being at center vertically
    velocity: 0, // initial velocity is 0
    lives: 3, // total lives: 3
    score: 0, // initial score
    seed: Constants.SEED, // initialize the random seed
    resume: false, // initial resume flag
    fullScore: 0, // total number of pipes
    pipes: [], // start with empty array
    all_pipes: [],
    time: 0, // initialize time(s)
    pause: false, // game not paused initially
};

const isOverlap = (a: Box, b: Box): boolean => {
    const aRight = a.x + a.width;
    const aBottom = a.y + a.height;
    const bRight = b.x + b.width;
    const bBottom = b.y + b.height;

    const result =
        a.x >= bRight - 15 ||
        aRight <= b.x + 15 ||
        a.y >= bBottom - 5 ||
        aBottom <= b.y + 15;

    return !result;
};

const createBox = (
    x: number,
    y: number,
    width: number,
    height: number,
): Box => {
    return {
        x: x,
        y: y,
        width: width,
        height: height,
    };
};

/**
 * Updates the state by proceeding with one time step.
 *
 * @param s Current state
 * @returns Updated state
 */
const tick = (s: State) => {
    if (!s.gameStart && !s.gameEnd && s.pipes.length > 0) {
        return { ...s, gameStart: true };
    }

    // Game win, stops
    //if (s.gameEnd && s.lives > 0) return s;

    console.log(s.score, s.fullScore);
    if (s.gameStart && s.score === s.fullScore) return { ...s, gameEnd: true };

    if (s.gamePause) return s;

    // update bird position
    const newPosition = s.position + s.velocity;
    // update velocity
    const newVelocity = s.velocity + Constants.GRAVITY;
    // update seed
    const newSeed = RNG.hash(s.seed);
    // update time
    const newTime = s.time + Constants.TICK_RATE_MS;

    // Reviving: if bird is trying to revive
    if (s.resume) {
        // if bird is invisible and has remaining lives, reset the bird
        if (
            newPosition > Constants.GROUND + 50 ||
            newPosition < Constants.CEILING - 50
        ) {
            if (s.lives > 0)
                return {
                    ...initialState,
                    lives: s.lives,
                    seed: newSeed,
                    resume: false,
                    gameStart: true,
                    pipes: s.pipes,
                    score: s.score,
                    all_pipes: s.all_pipes,
                    fullScore: s.fullScore,
                };
            // if the bird is dead, terminate
            return {
                ...s,
                gameEnd: true,
            };
        }

        // just let bird bounce off
        return {
            ...s,
            position: newPosition,
            velocity: newVelocity,
            time: newTime,
        };
    }

    const hit_bottom_state = {
        ...s,
        lives: s.lives - 1,
        seed: newSeed,
        resume: true,
        velocity: 5 * (RNG.scale(newSeed) - 2),
        time: newTime,
    } as State;

    const hit_top_state = {
        ...s,
        lives: s.lives - 1,
        seed: newSeed,
        resume: true,
        velocity: 5 * (RNG.scale(newSeed) + 2),
        time: newTime,
    } as State;

    const bird_box = createBox(
        Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2,
        s.position,
        Birb.WIDTH,
        Birb.HEIGHT,
    );

    const hit_top_results = s.pipes.map(p => {
        const top_pipe = createBox(
            p.x,
            0,
            Constants.PIPE_WIDTH,
            (p.gapY - p.gapHeight / 2) * Viewport.CANVAS_HEIGHT,
        );
        return isOverlap(bird_box, top_pipe);
    });

    const hit_top = hit_top_results.includes(true);
    if (hit_top) return hit_top_state;

    const hit_bottom_results = s.pipes.map(p => {
        const bottom_pipe = createBox(
            p.x,
            (p.gapY + p.gapHeight / 2) * Viewport.CANVAS_HEIGHT,
            Constants.PIPE_WIDTH,
            Viewport.CANVAS_HEIGHT -
                (p.gapY + p.gapHeight / 2) * Viewport.CANVAS_HEIGHT,
        );
        return isOverlap(bird_box, bottom_pipe);
    });

    const hit_bottom = hit_bottom_results.includes(true);
    if (hit_bottom) return hit_bottom_state;

    // Flying: check if bird hits the ground
    if (newPosition >= Constants.GROUND) return hit_bottom_state;

    // Flying: check if bird hits the ceils
    if (newPosition <= Constants.CEILING) return hit_top_state;

    // flying normally, continue with new velocity and position
    return {
        ...s,
        position: newPosition,
        velocity: newVelocity,
        time: newTime,
    };
};

// Rendering (side effects)

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const bringToForeground = (elem: SVGElement): void => {
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "visible");
    bringToForeground(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

const render = (): ((s: State) => void) => {
    // Canvas elements
    const gameStart = document.querySelector("#gameStart") as SVGElement;
    const gameOver = document.querySelector("#gameOver") as SVGElement;
    const gameWin = document.querySelector("#gameWin") as SVGElement;
    const gamePause = document.querySelector("#gamePause") as SVGElement;
    const container = document.querySelector("#main") as HTMLElement;

    // Text fields
    const livesText = document.querySelector("#livesText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

    svg.setAttribute(
        "viewBox",
        `0 0 ${Viewport.CANVAS_WIDTH} ${Viewport.CANVAS_HEIGHT}`,
    );

    // Add birb to the main grid canvas
    const birdImg = createSvgElement(svg.namespaceURI, "image", {
        href: "assets/birb.png",
        x: `${Viewport.CANVAS_WIDTH * 0.3 - Birb.WIDTH / 2}`,
        y: `${Viewport.CANVAS_HEIGHT / 2 - Birb.HEIGHT / 2}`,
        width: `${Birb.WIDTH}`,
        height: `${Birb.HEIGHT}`,
    });

    // Define a function to create a top pipe
    const createTopPipe = (p: Pipe): SVGElement => {
        return createSvgElement(svg.namespaceURI, "rect", {
            x: p.x.toString(),
            y: "0",
            width: `${Constants.PIPE_WIDTH}`,
            height: `${(p.gapY - p.gapHeight / 2) * Viewport.CANVAS_HEIGHT}`,
            fill: "green",
            isTop: "1",
        });
    };

    // Define a function to create a bottom pipe
    const createBottomPipe = (p: Pipe): SVGElement => {
        return createSvgElement(svg.namespaceURI, "rect", {
            x: p.x.toString(),
            y: `${(p.gapY + p.gapHeight / 2) * Viewport.CANVAS_HEIGHT}`,
            width: `${Constants.PIPE_WIDTH}`,
            height: `${Viewport.CANVAS_HEIGHT - (p.gapY + p.gapHeight / 2) * Viewport.CANVAS_HEIGHT}`,
            fill: "green",
            isTop: "0",
        });
    };

    /**
     * Renders the current state to the canvas.
     *
     * In MVC terms, this updates the View using the Model.
     *
     * @param s Current state
     */

    show(gameStart);

    return (s: State) => {
        // update the position of bird
        birdImg.setAttribute("y", `${s.position - Birb.HEIGHT / 2}`);
        // update the position of pipes
        const existingPipes = svg.querySelectorAll(".pipe");
        existingPipes.forEach(pipe => pipe.remove());
        s.pipes.forEach(pipe => {
            const topPipe = createTopPipe(pipe);
            const bottomPipe = createBottomPipe(pipe);
            topPipe.classList.add("pipe");
            bottomPipe.classList.add("pipe");
            svg.appendChild(topPipe);
            svg.appendChild(bottomPipe);
        });

        svg.appendChild(birdImg);

        // update score and lives
        livesText.textContent = `${s.lives}`;
        scoreText.textContent = `${s.score}`;
        // show or hide game over
        if (s.gameEnd) {
            if (s.lives === 0) {
                show(gameOver);
            } else {
                show(gameWin);
            }
        } else {
            hide(gameOver);
            hide(gameWin);
            if (s.gamePause) show(gamePause);
            else hide(gamePause);
        }
        hide(gameStart);
    };
};

export const state$ = (csvContents: string): Observable<State> => {
    //Parse csv string
    const pipe_array = csvContents
        .split("\n")
        .slice(1)
        .map(row => {
            const [gap_y, gap_height, delay] = row.split(",");
            return {
                gapY: Number(gap_y),
                gapHeight: Number(gap_height),
                delay: Number(delay),
            };
        });

    // Create a pipe stream
    const pipes$ = pipe_array.map(entry =>
        interval(Constants.TICK_RATE_MS).pipe(
            map(() => (currentState: State) => {
                if (currentState.gamePause || currentState.gameEnd)
                    return currentState;
                if (currentState.time >= entry.delay * 1000) {
                    const pipeExists = currentState.all_pipes.some(
                        p =>
                            p.gapY === entry.gapY &&
                            p.gapHeight === entry.gapHeight &&
                            p.delay === entry.delay,
                    );
                    if (!pipeExists) {
                        const newPipe: Pipe = {
                            gapY: Number(entry.gapY),
                            gapHeight: Number(entry.gapHeight),
                            delay: Number(entry.delay),
                            x: Viewport.CANVAS_WIDTH,
                        };
                        return {
                            ...currentState,
                            all_pipes: [...currentState.all_pipes, newPipe],
                            fullScore: pipe_array.length,
                        };
                    }
                }
                return currentState;
            }),
        ),
    );

    // Create a separate stream to update pipe positions
    const movePipes$ = interval(Constants.TICK_RATE_MS).pipe(
        map(() => (currentState: State) => {
            // Move each pipe to the left by PIPE_SPEED
            const updatedPipes = currentState.all_pipes.map(pipe => ({
                ...pipe,
                x: pipe.x - Constants.PIPE_SPEED,
            }));

            const newScore = currentState.all_pipes.filter(
                pipe => pipe.x - Constants.PIPE_WIDTH < currentState.score,
            ).length;

            if (currentState.gamePause) return currentState;
            return {
                ...currentState,
                all_pipes: updatedPipes,
                pipes: updatedPipes.filter(
                    pipe => pipe.x > -Constants.PIPE_WIDTH,
                ),
                score: newScore,
            };
        }),
    );

    /** User input */
    const key$ = fromEvent<KeyboardEvent>(document, "keypress");
    const fromKey = (keyCode: Key) =>
        key$.pipe(filter(({ code }) => code === keyCode));

    const jump$ = fromKey("Space").pipe(
        // apply velocity change if the game is going on
        map(() => (currentState: State) => {
            if (!currentState.resume)
                return {
                    ...currentState,
                    velocity: Constants.JUMP_SPEED, // Fixed upward velocity
                };
            return currentState;
        }),
    );

    const pause$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
        filter(event => event.code === "KeyP"),
        map(() => (currentState: State) => {
            return { ...currentState, gamePause: !currentState.gamePause };
        }),
    );

    /** Determines the rate of time steps */
    const tick$ = interval(Constants.TICK_RATE_MS).pipe(map(() => tick));

    // Press R to restart game
    const restart$ = fromEvent<KeyboardEvent>(document, "keydown").pipe(
        filter(event => event.code === "KeyR"),
    );

    return restart$.pipe(
        startWith(null),
        switchMap(() =>
            merge(jump$, tick$, ...pipes$, movePipes$, pause$).pipe(
                scan((s: State, reducerFn) => reducerFn(s), initialState),
            ),
        ),
    );
};

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map2.csv`;

    // Get the file from URL
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) {
                return response.text();
            } else {
                throw new Error(`Fetch error: ${response.status}`);
            }
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            throw err;
        }),
    );

    // Observable: wait for first user click
    const click$ = fromEvent(document.body, "mousedown").pipe(take(1));

    csv$.pipe(
        switchMap(contents =>
            // On click - start the game
            click$.pipe(switchMap(() => state$(contents))),
        ),
    ).subscribe(render());
}
