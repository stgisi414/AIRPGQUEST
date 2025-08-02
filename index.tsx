    import React, { useState, useEffect, useCallback, FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Type } from "@google/genai";
import './game.css';

const safetySettings = [
    {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'BLOCK_NONE',
    },
    {
        category: 'HARM_CATEGORY_HATE_SPEECH',
        threshold: 'BLOCK_NONE',
    },
    {
        category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        threshold: 'BLOCK_NONE',
    },
    {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_NONE',
    },
];

// --- TYPE DEFINITIONS ---
interface Character {
  name: string;
  hp: number;
  xp: number;
  skills: { [key: string]: number };
  skillPoints: number;
  description: string;
  portrait: string; // base64 image
}

interface StorySegment {
  text: string;
  illustration: string; // base64 image
}

type SkillPools = { [key: string]: string[] };

interface GameState {
  character: Character | null;
  storyLog: StorySegment[];
  currentActions: string[];
  storyGuidance: {
    plot: string;
    setting: string;
  } | null;
  skillPools: SkillPools | null;
  gameStatus: 'characterCreation' | 'characterCustomize' | 'levelUp' | 'playing' | 'loading' | 'initial_load';
}

// Data stored before character is finalized
interface CreationData {
    name: string;
    description: string;
    storyGuidance: GameState['storyGuidance'];
    initialStory: { text: string; actions: string[] };
    skillPools: SkillPools;
    startingSkillPoints: number;
}

// Data from initial creation form
interface CreationDetails {
    name: string;
    gender: string;
    race: string;
    characterClass: string;
    background: string;
}


const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- API SCHEMAS ---
const characterGenSchema = {
  type: Type.OBJECT,
  properties: {
    character: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        description: { type: Type.STRING, description: "A detailed physical and personality description of the character, suitable for generating a portrait image." },
      },
      required: ['name', 'description']
    },
    storyGuidance: {
      type: Type.OBJECT,
      properties: {
        plot: { type: Type.STRING, description: "A high-level summary of a multi-act fantasy story plot." },
        setting: { type: Type.STRING, description: "A description of the game's world and setting." }
      },
      required: ['plot', 'setting']
    },
    initialStory: {
        type: Type.OBJECT,
        properties: {
            text: { type: Type.STRING, description: "The opening paragraph of the story, introducing the character and the scene."},
            actions: { type: Type.ARRAY, items: { type: Type.STRING }, description: "An array of 3-4 initial actions the player can take."}
        },
        required: ['text', 'actions']
    },
    skillPools: {
        type: Type.OBJECT,
        description: "Three pools of skills for the player to choose from, categorized as 'Combat', 'Magic', and 'Utility'. Each pool should contain 4-5 unique skills.",
        properties: {
            Combat: { type: Type.ARRAY, items: { type: Type.STRING } },
            Magic: { type: Type.ARRAY, items: { type: Type.STRING } },
            Utility: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['Combat', 'Magic', 'Utility']
    },
    startingSkillPoints: { type: Type.INTEGER, description: "The number of points the player can initially spend on skills. Usually 5-7."}
  },
  required: ['character', 'storyGuidance', 'initialStory', 'skillPools', 'startingSkillPoints']
};


const nextStepSchema = {
    type: Type.OBJECT,
    properties: {
        story: {
            type: Type.OBJECT,
            properties: {
                text: { type: Type.STRING, description: "The next paragraph of the story, describing the outcome of the player's action."},
                actions: { type: Type.ARRAY, items: { type: Type.STRING }, description: "A new array of 3-4 actions the player can take now."},
                didHpChange: { type: Type.INTEGER, description: "The number of HP points the character gained or lost (e.g., -10 or 5). Should be 0 if no change."},
                didXpChange: { type: Type.INTEGER, description: "The number of XP points the character gained. Should be 0 if no change."}
            },
            required: ['text', 'actions', 'didHpChange', 'didXpChange']
        }
    },
    required: ['story']
}

// --- STATIC DATA ---
const RACES = ["Human", "Elf", "Dwarf", "Orc", "Halfling", "Gnome", "Dragonborn", "Tiefling", "Half-Elf"];
const CLASSES = ["Warrior", "Paladin", "Ranger", "Rogue", "Monk", "Barbarian", "Bard", "Cleric", "Druid", "Sorcerer", "Warlock", "Wizard", "Artificer", "Blood Hunter", "Death Knight", "Demon Hunter", "Spellblade", "Necromancer", "Summoner", "Elementalist", "Shaman", "Templar", "Assassin", "Swashbuckler", "Gunslinger", "Alchemist", "Berserker", "Gladiator", "Scout", "Inquisitor"];
const BACKGROUNDS = ["Commoner", "Noble", "Royalty", "Magical Family", "Farmer", "Soldier", "Criminal", "Sage", "Artisan", "Entertainer", "Hermit", "Outcast", "Merchant", "Acolyte", "Urchin"];


// --- UI COMPONENTS ---

const Loader = ({ text }: { text: string }) => (
  <div className="loader-container">
    <div className="loader"></div>
    <p>{text}</p>
  </div>
);

const CustomActionModal = ({ isOpen, onClose, onSubmit, isLoading }: { isOpen: boolean, onClose: () => void, onSubmit: (action: string) => void, isLoading: boolean }) => {
    const [customAction, setCustomAction] = useState('');

    if (!isOpen) return null;

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        if (customAction.trim()) {
            onSubmit(customAction.trim());
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <h2>Describe Your Action</h2>
                <p>What do you want to do? Be descriptive for the best result.</p>
                <form onSubmit={handleSubmit}>
                    <textarea
                        value={customAction}
                        onChange={e => setCustomAction(e.target.value)}
                        placeholder="e.g., 'Search the room for hidden clues' or 'Try to persuade the guard with a silver coin'"
                        rows={4}
                        disabled={isLoading}
                        aria-label="Custom action input"
                        autoFocus
                    />
                    <div className="modal-actions">
                        <button type="button" onClick={onClose} disabled={isLoading} className="cancel-btn">Cancel</button>
                        <button type="submit" disabled={isLoading || !customAction.trim()}>
                            {isLoading ? "Continuing..." : "Submit Action"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};


const CharacterCreationScreen = ({ onCreate, isLoading }: { onCreate: (details: CreationDetails) => void, isLoading: boolean }) => {
  const [name, setName] = useState('');
  const [gender, setGender] = useState('Male');
  const [race, setRace] = useState(RACES[0]);
  const [characterClass, setCharacterClass] = useState(CLASSES[0]);
  const [background, setBackground] = useState(BACKGROUNDS[0]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onCreate({ name: name.trim(), gender, race, characterClass, background });
    }
  };

  return (
    <div className="creation-container">
      <h1><img src="/ea-logo.png" />&nbsp;Endless Adventure</h1>
      <p>Welcome, traveler. A new world of adventure awaits. Define your hero, and the saga will begin.</p>
      <form onSubmit={handleSubmit} className="creation-form">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter your character's name"
          aria-label="Character name"
          disabled={isLoading}
          className="full-width-input"
        />

        <div className="radio-group">
            <input type="radio" id="gender-male" name="gender" value="Male" checked={gender === 'Male'} onChange={(e) => setGender(e.target.value)} />
            <label htmlFor="gender-male">Male</label>
            <input type="radio" id="gender-female" name="gender" value="Female" checked={gender === 'Female'} onChange={(e) => setGender(e.target.value)} />
            <label htmlFor="gender-female">Female</label>
        </div>

        <div className="form-grid">
            <div className="form-group">
                <label htmlFor="race-select">Race</label>
                <select id="race-select" value={race} onChange={e => setRace(e.target.value)} disabled={isLoading}>
                    {RACES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
            </div>

            <div className="form-group">
                <label htmlFor="class-select">Class</label>
                <select id="class-select" value={characterClass} onChange={e => setCharacterClass(e.target.value)} disabled={isLoading}>
                    {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
            </div>
        </div>
        
        <div className="form-group">
            <label htmlFor="background-select">Background</label>
             <select id="background-select" value={background} onChange={e => setBackground(e.target.value)} disabled={isLoading}>
                {BACKGROUNDS.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
        </div>


        <button type="submit" disabled={isLoading || !name.trim()}>
          {isLoading ? 'Conjuring World...' : 'Begin Your Journey'}
        </button>
      </form>
    </div>
  );
};

const SkillAllocator = ({ title, skillPools, availablePoints, initialSkills = {}, onComplete, completeButtonText, onCancel}: { title: string, skillPools: SkillPools, availablePoints: number, initialSkills?: { [key: string]: number }, onComplete: (skills: {[key: string]: number}) => void, completeButtonText: string, onCancel?: () => void }) => {
    const [skills, setSkills] = useState(initialSkills);
    const [points, setPoints] = useState(availablePoints);

    const handleSkillChange = (skillName: string, change: number) => {
        const currentLevel = skills[skillName] || 0;
        const newLevel = currentLevel + change;

        if (change > 0 && points <= 0) return; // No points to spend

        if (newLevel < 0) return; // Cannot go below 0
        if (newLevel === 0 && currentLevel > 0) { // Removing a skill
             const newSkills = {...skills};
             delete newSkills[skillName];
             setSkills(newSkills);
             setPoints(points + currentLevel);
        } else {
            setSkills(s => ({...s, [skillName]: newLevel}));
            setPoints(p => p - change);
        }
    }
    
    const allSkills = Object.values(skillPools).flat();
    const learnedSkills = Object.keys(skills);
    const unlearnedSkills = allSkills.filter(s => !learnedSkills.includes(s));

    const renderSkillControls = (skillName: string) => {
        const level = skills[skillName] || 0;
        return (
            <div className="skill-control">
                <span>{skillName} <span className="skill-level">Lvl {level}</span></span>
                <div className="skill-buttons">
                    <button onClick={() => handleSkillChange(skillName, -1)} disabled={level <= 0}>-</button>
                    <button onClick={() => handleSkillChange(skillName, 1)} disabled={points <= 0}>+</button>
                </div>
            </div>
        )
    };

    return (
        <div className="skill-allocator">
            <h1>{title}</h1>
            <div className="skill-points-counter">
                <h2>Skill Points Remaining: <span>{points}</span></h2>
            </div>
            <div className="skill-columns">
                {Object.entries(skillPools).map(([category, skillNames]) => (
                    <div className="skill-category" key={category}>
                        <h3>{category}</h3>
                        <ul className="skills-list">
                            {skillNames.map(skill => (
                                <li key={skill} className={skills[skill] ? 'learned' : ''}>
                                    {renderSkillControls(skill)}
                                </li>
                            ))}
                        </ul>
                    </div>
                ))}
            </div>
             <div className="skill-allocator-actions">
                {onCancel && <button onClick={onCancel} className="cancel-btn">Cancel</button>}
                <button onClick={() => onComplete(skills)} disabled={points < 0}>
                    {completeButtonText}
                </button>
            </div>
        </div>
    );
};

const GameScreen = ({ gameState, onAction, onNewGame, onLevelUp, isLoading, onCustomActionClick }: { gameState: GameState, onAction: (action: string) => void, onNewGame: () => void, onLevelUp: () => void, isLoading: boolean, onCustomActionClick: () => void}) => {
    if (!gameState.character || gameState.storyLog.length === 0) {
        return <Loader text="Loading game..." />;
    }

    const { character, storyLog, currentActions } = gameState;
    const currentScene = storyLog[storyLog.length - 1];

    return (
        <div className="game-container">
            <header className="game-header">
                <h1><img src="/ea-logo.png" />&nbsp;Endless Adventure</h1>
                <button onClick={onNewGame} className="new-game-btn">Start New Game</button>
            </header>
            <main className="game-main">
                <div className="character-panel">
                    <img src={character.portrait} alt={`${character.name}'s portrait`} className="character-portrait" />
                    <h2>{character.name}</h2>
                    <div className="stats-grid">
                        <div className="stat-item">
                            <span className="stat-label">HP</span>
                            <span className="stat-value">{character.hp}</span>
                        </div>
                         <div className="stat-item">
                            <span className="stat-label">XP</span>
                            <span className="stat-value">{character.xp}</span>
                        </div>
                    </div>

                    {character.skillPoints > 0 && (
                        <button onClick={onLevelUp} className="level-up-btn">
                            Level Up ({character.skillPoints} Points)
                        </button>
                    )}

                    <h3>Skills</h3>
                    <ul className="skills-list">
                        {Object.entries(character.skills).sort(([, lvlA], [, lvlB]) => lvlB - lvlA).map(([skill, level]) => (
                            <li key={skill}>{skill} <span className="skill-level">Lvl {level}</span></li>
                        ))}
                    </ul>
                </div>
                <div className="story-panel">
                    <div className="illustration-container">
                       {isLoading && <div className="illustration-loader"><Loader text="Drawing next scene..."/></div>}
                       <img src={currentScene.illustration} alt="Current scene" className={`story-illustration ${isLoading ? 'loading' : ''}`} />
                    </div>
                    <div className="story-text">
                        <p>{currentScene.text}</p>
                    </div>
                    <div className="actions-panel">
                        {currentActions.map(action => (
                            <button key={action} onClick={() => onAction(action)} disabled={isLoading}>
                                {action}
                            </button>
                        ))}
                        <button onClick={onCustomActionClick} disabled={isLoading} className="custom-action-btn">
                            Custom Action...
                        </button>
                    </div>
                </div>
            </main>
        </div>
    );
}

// --- MAIN APP ---

const App = () => {
  const [gameState, setGameState] = useState<GameState>({
    character: null,
    storyLog: [],
    currentActions: [],
    storyGuidance: null,
    skillPools: null,
    gameStatus: 'initial_load',
  });
  const [creationData, setCreationData] = useState<CreationData | null>(null);
  const [apiIsLoading, setApiIsLoading] = useState(false);
  const [isCustomActionModalOpen, setIsCustomActionModalOpen] = useState(false);

  // Load from localStorage on startup
  useEffect(() => {
    try {
      const savedState = localStorage.getItem('endlessAdventureSave');
      if (savedState) {
        const {gameState: savedGameState, creationData: savedCreationData} = JSON.parse(savedState);
        setGameState(savedGameState);
        if (savedCreationData) {
            setCreationData(savedCreationData);
        }
      } else {
        setGameState(g => ({ ...g, gameStatus: 'characterCreation' }));
      }
    } catch (error) {
      console.error("Failed to load saved state:", error);
      handleNewGame(); // Reset if save is corrupted
    }
  }, []);

  // Save to localStorage on change
  useEffect(() => {
    if (gameState.gameStatus !== 'initial_load') {
      localStorage.setItem('endlessAdventureSave', JSON.stringify({gameState, creationData}));
    }
  }, [gameState, creationData]);

  const generateImage = useCallback(async (prompt: string): Promise<string> => {
    try {
        const response = await ai.models.generateImages({
            model: 'imagen-3.0-generate-002',
            prompt: `fantasy art, digital painting. ${prompt}`,
            config: {
                numberOfImages: 1,
                outputMimeType: 'image/jpeg',
                aspectRatio: '16:9',
                safetySettings: safetySettings,
            },
        });
        const base64ImageBytes = response.generatedImages[0].image.imageBytes;
        return `data:image/jpeg;base64,${base64ImageBytes}`;
    } catch (error) {
        console.error("Image generation failed:", error);
        return "";
    }
  }, []);

  const handleCreateCharacter = useCallback(async (details: CreationDetails) => {
    setApiIsLoading(true);
    setGameState(g => ({...g, gameStatus: 'loading'}));

    const { name, gender, race, characterClass, background } = details;

    try {
        const prompt = `
            Generate a fantasy character, story guidance, skill pools, and an opening scene for a text adventure game.
            The player has defined their character with the following attributes:
            - Name: '${name}'
            - Gender: ${gender}
            - Race: ${race}
            - Class: ${characterClass}
            - Background: ${background}

            Base the character's description, the initial story, and the available skill pools on these attributes. For example, a 'Noble' 'Knight' might start in a castle, whereas a 'Farmer' 'Ranger' might start in the wilderness. The skills should reflect their class and background. Ensure the character description is detailed and suitable for generating a portrait.
        `;
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: characterGenSchema,
                safetySettings: safetySettings,
            },
        });

        const data = JSON.parse(response.text);
        
        setCreationData({
            name: data.character.name,
            description: data.character.description,
            storyGuidance: data.storyGuidance,
            initialStory: data.initialStory,
            skillPools: data.skillPools,
            startingSkillPoints: data.startingSkillPoints
        });
        setGameState(g => ({...g, gameStatus: 'characterCustomize'}));

    } catch (error) {
        console.error("Character creation failed:", error);
        handleNewGame();
    } finally {
        setApiIsLoading(false);
    }
  }, []);

  const handleFinalizeCharacter = useCallback(async (chosenSkills: {[key: string]: number}) => {
     if (!creationData) return;
     setApiIsLoading(true);
     setGameState(g => ({...g, gameStatus: 'loading'}));

     try {
        const [portrait, illustration] = await Promise.all([
            generateImage(creationData.description),
            generateImage(`${creationData.storyGuidance.setting}. ${creationData.initialStory.text}`)
        ]);

        const newCharacter: Character = {
            name: creationData.name,
            hp: 100,
            xp: 0,
            skills: chosenSkills,
            skillPoints: 0,
            description: creationData.description,
            portrait: portrait
        };
        const initialSegment: StorySegment = { text: creationData.initialStory.text, illustration };

        setGameState({
            character: newCharacter,
            storyGuidance: creationData.storyGuidance,
            skillPools: creationData.skillPools,
            storyLog: [initialSegment],
            currentActions: creationData.initialStory.actions,
            gameStatus: 'playing'
        });
        setCreationData(null); // Clean up temp data

     } catch (error) {
        console.error("Character finalization failed:", error);
        handleNewGame();
     } finally {
         setApiIsLoading(false);
     }
  }, [creationData, generateImage]);


  const handleAction = useCallback(async (action: string) => {
      if (!gameState.character || !gameState.storyGuidance) return;
      setApiIsLoading(true);

      try {
          const storyHistory = gameState.storyLog.map(s => s.text).join('\n\n');
          const prompt = `
            Continue this text adventure.
            STORY GUIDANCE:
            Setting: ${gameState.storyGuidance.setting}
            Plot: ${gameState.storyGuidance.plot}

            CHARACTER:
            Name: ${gameState.character.name}
            HP: ${gameState.character.hp}
            XP: ${gameState.character.xp}
            Skills: ${Object.entries(gameState.character.skills).map(([skill, level]) => `${skill} (Lvl ${level})`).join(', ')}
            Description: ${gameState.character.description}

            STORY SO FAR:
            ${storyHistory}

            PLAYER ACTION: "${action}"

            Generate the next part of the story based on the player's action. Update HP/XP if necessary. Provide new actions. Keep the story moving forward.
          `;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: nextStepSchema,
                safetySettings: safetySettings,
            },
        });
        
        const data = JSON.parse(response.text).story;
        const newIllustration = await generateImage(`${gameState.storyGuidance.setting}. ${data.text}`);
        const newSegment: StorySegment = { text: data.text, illustration: newIllustration };

        setGameState(prevState => {
            if (!prevState.character) return prevState;
            const oldXp = prevState.character.xp;
            const newXp = oldXp + data.didXpChange;
            const earnedSkillPoints = Math.floor(newXp / 100) - Math.floor(oldXp / 100);

            const updatedCharacter = {
                ...prevState.character,
                hp: prevState.character.hp + data.didHpChange,
                xp: newXp,
                skillPoints: prevState.character.skillPoints + earnedSkillPoints
            };
            return {
                ...prevState,
                character: updatedCharacter,
                storyLog: [...prevState.storyLog, newSegment],
                currentActions: data.actions
            };
        });

      } catch (error) {
          console.error("Action handling failed:", error);
      } finally {
          setApiIsLoading(false);
      }
  }, [gameState, generateImage]);
  
  const handleCustomActionSubmit = (action: string) => {
      setIsCustomActionModalOpen(false);
      handleAction(action);
  };

  const handleLevelUpComplete = (updatedSkills: {[key: string]: number}) => {
      setGameState(g => {
        if (!g.character) return g;
        
        const pointsSpent = Object.values(updatedSkills).reduce((sum, level) => sum + level, 0) - Object.values(g.character.skills).reduce((sum, level) => sum + level, 0);

        return {
            ...g,
            character: {
                ...g.character,
                skills: updatedSkills,
                skillPoints: g.character.skillPoints - pointsSpent,
            },
            gameStatus: 'playing'
        }
      });
  };

  const handleNewGame = () => {
    localStorage.removeItem('endlessAdventureSave');
    setCreationData(null);
    setGameState({
        character: null,
        storyLog: [],
        currentActions: [],
        storyGuidance: null,
        skillPools: null,
        gameStatus: 'characterCreation',
    });
  }

  const renderContent = () => {
    switch (gameState.gameStatus) {
      case 'playing':
        return <GameScreen 
                    gameState={gameState} 
                    onAction={handleAction} 
                    onNewGame={handleNewGame} 
                    onLevelUp={() => setGameState(g => ({...g, gameStatus: 'levelUp'}))} 
                    isLoading={apiIsLoading}
                    onCustomActionClick={() => setIsCustomActionModalOpen(true)}
                />;
      case 'characterCreation':
        return <CharacterCreationScreen onCreate={handleCreateCharacter} isLoading={apiIsLoading} />;
      case 'characterCustomize':
        if (!creationData) return <Loader text="Loading customization..." />;
        return <SkillAllocator
                    title="Customize Your Character"
                    skillPools={creationData.skillPools}
                    availablePoints={creationData.startingSkillPoints}
                    onComplete={handleFinalizeCharacter}
                    completeButtonText="Finalize Character & Begin"
                />
      case 'levelUp':
        if (!gameState.character || !gameState.skillPools) return <Loader text="Loading..."/>;
        return <SkillAllocator
                    title="Level Up Your Skills"
                    skillPools={gameState.skillPools}
                    availablePoints={gameState.character.skillPoints}
                    initialSkills={gameState.character.skills}
                    onComplete={handleLevelUpComplete}
                    onCancel={() => setGameState(g => ({...g, gameStatus: 'playing'}))}
                    completeButtonText="Confirm Skills"
                />
      case 'loading':
        return <Loader text="Your story is being written..." />;
      case 'initial_load':
      default:
        return <Loader text="Loading..." />;
    }
  };

  return (
    <div id="app-container">
        {renderContent()}
        <CustomActionModal
            isOpen={isCustomActionModalOpen}
            onClose={() => setIsCustomActionModalOpen(false)}
            onSubmit={handleCustomActionSubmit}
            isLoading={apiIsLoading}
        />
    </div>
    );
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
