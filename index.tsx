import React, { useState, useEffect, useCallback, FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, Type } from "@google/genai";
import { Preferences } from '@capacitor/preferences';
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
  gender: string;
  hp: number;
  xp: number;
  skills: { [key: string]: number };
  skillPoints: number;
  description: string;
  portrait: string; // base64 image
  storySummary?: string;
  reputation: { [key: string]: number };
}

interface StorySegment {
  text: string;
  illustration: string; // base64 image
}

type SkillPools = { [key: string]: string[] };

interface Companion {
  name: string;
  description: string;
  skills: { [key: string]: number };
  personality: string; // e.g., "Loyal but cautious," "Brave and reckless"
  relationship: number; // A score from -100 to 100 representing their view of the player
}

const CAMPAIGN_TYPES = [
  "Revenge Story", "Romantic Conquest", "World War", "Monster Hunt",
  "Political Intrigue", "Guild Rivalry", "Lost Heir", "Cursed Land",
  "Ancient Prophecy", "Exploration and Discovery", "Defend the Realm", "Heist",
  "Magical Tournament", "Survive the Apocalypse", "Solve a Mystery", "Uprising Against Tyranny",
  "Thieves' Guild Initiation", "Royal Escort Mission", "Artifact Recovery", "Establish a Colony",
  "Gladiator Arena", "Spy Thriller", "Cosmic Horror", "Time Travel Paradox"
];

interface GameState {
  character: Character | null;
  companions: Companion[];
  storyLog: StorySegment[];
  currentActions: string[];
  storyGuidance: {
    plot: string;
    setting: string;
  } | null;
  skillPools: SkillPools | null;
  gameStatus: 'characterCreation' | 'characterCustomize' | 'levelUp' | 'playing' | 'loading' | 'initial_load';
  weather: string;
  timeOfDay: string;
}

// Data stored before character is finalized
interface CreationData {
    name: string;
    gender: string;
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
    campaign: string;
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
    companions: {
      type: Type.ARRAY,
      description: "An array of 1-2 starting companions for the player's party. Give each a unique name, description, personality, and skills.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          personality: { type: Type.STRING },
          skills: {
            type: Type.ARRAY,
            description: "An array of objects, where each object represents a skill and its level.",
            items: {
                type: Type.OBJECT,
                properties: {
                    skillName: {
                        type: Type.STRING,
                        description: "The name of the skill (e.g., 'Swords', 'Alchemy')."
                    },
                    level: {
                        type: Type.INTEGER,
                        description: "The level of the skill."
                    }
                },
                required: ['skillName', 'level']
            }
          }
        },
        required: ['name', 'description', 'personality', 'skills']
      }
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
  required: ['character', 'storyGuidance', 'initialStory', 'skillPools', 'startingSkillPoints', 'companions']
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
                didXpChange: { type: Type.INTEGER, description: "The number of XP points the character gained. Should be 0 if no change."},
                companionUpdates: {
                    type: Type.ARRAY,
                    description: "An array of updates for companions. Includes relationship changes.",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            name: { type: Type.STRING, description: "The name of the companion to update." },
                            relationshipChange: { type: Type.INTEGER, description: "How much the relationship score changed." }
                        },
                        required: ['name', 'relationshipChange']
                    }
                },
                newCompanion: {
                    type: Type.OBJECT,
                    description: "If a new companion can be recruited in this story segment, describe them here. Otherwise, this should be null.",
                    nullable: true,
                    properties: {
                        name: { type: Type.STRING },
                        description: { type: Type.STRING },
                        personality: { type: Type.STRING },
                        // REPLACE the old 'skills' definition with this one:
                        skills: {
                            type: Type.ARRAY,
                            description: "An array of objects, where each object represents a skill and its level.",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    skillName: {
                                        type: Type.STRING,
                                        description: "The name of the skill."
                                    },
                                    level: {
                                        type: Type.INTEGER,
                                        description: "The level of the skill."
                                    }
                                },
                                required: ['skillName', 'level']
                            }
                        }
                    },
                },
                reputationChange: { type: Type.OBJECT, description: "An object representing reputation changes with factions. e.g., {'City Guard': -10, 'Thieves Guild': 5}. Only include factions whose reputation changed.", properties: { faction: { type: Type.STRING }, change: { type: Type.INTEGER } } },
                newWeather: { type: Type.STRING, description: "The new weather condition (e.g., 'Clear Skies', 'Light Rain', 'Snowing')." },
                newTimeOfDay: { type: Type.STRING, description: "The new time of day (e.g., 'Morning', 'Afternoon', 'Night')." }
            },
            required: ['text', 'actions', 'didHpChange', 'didXpChange', 'companionUpdates', 'newCompanion', 'reputationChange', 'newWeather', 'newTimeOfDay']
        }
    },
    required: ['story']
}

const storySummarySchema = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: "A detailed, narrative summary of the character's story so far. It should read like a chapter in a book."
    }
  },
  required: ['summary']
};

// --- STATIC DATA ---
const RACES = ["Human", "Elf", "Dwarf", "Orc", "Halfling", "Gnome", "Dragonborn", "Tiefling", "Half-Elf"];
const CLASSES = ["Warrior", "Paladin", "Ranger", "Rogue", "Monk", "Barbarian", "Bard", "Cleric", "Druid", "Sorcerer", "Warlock", "Wizard", "Artificer", "Blood Hunter", "Death Knight", "Demon Hunter", "Spellblade", "Necromancer", "Summoner", "Elementalist", "Shaman", "Templar", "Assassin", "Swashbuckler", "Gunslinger", "Alchemist", "Berserker", "Gladiator", "Scout", "Inquisitor"];
const BACKGROUNDS = ["Commoner", "Noble", "Royalty", "Magical Family", "Farmer", "Soldier", "Criminal", "Sage", "Artisan", "Entertainer", "Hermit", "Outcast", "Merchant", "Acolyte", "Urchin"];

// --- HELPER FUNCTIONS for AUDIO ---
// Decodes base64 string to ArrayBuffer
const base64ToArrayBuffer = (base64: string) => {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
};

// Converts PCM data to a WAV file Blob
const pcmToWav = (pcmData: Int16Array, sampleRate: number): Blob => {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmData.length * (bitsPerSample / 8);
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + dataSize, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"

    // "fmt " sub-chunk
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true); // Sub-chunk size
    view.setUint16(20, 1, true); // Audio format (1 for PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // "data" sub-chunk
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, dataSize, true);

    // Write PCM data
    const pcmAsBytes = new Int16Array(buffer, 44);
    pcmAsBytes.set(pcmData);

    return new Blob([view], { type: 'audio/wav' });
};


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
  const [campaign, setCampaign] = useState(CAMPAIGN_TYPES[0]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onCreate({ name: name.trim(), gender, race, characterClass, background, campaign });
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

            <div className="form-group">
                <label htmlFor="background-select">Background</label>
                 <select id="background-select" value={background} onChange={e => setBackground(e.target.value)} disabled={isLoading}>
                    {BACKGROUNDS.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
            </div>

            <div className="form-group">
                <label htmlFor="campaign-select">Campaign Type</label>
                <select id="campaign-select" value={campaign} onChange={e => setCampaign(e.target.value)} disabled={isLoading}>
                    {CAMPAIGN_TYPES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
            </div>
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
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [audioUrl, setAudioUrl] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement>(null);

    if (!gameState.character || gameState.storyLog.length === 0) {
        return <Loader text="Loading game..." />;
    }

    const { character, storyLog, currentActions, companions = [] } = gameState;
    const { name, hp, xp, skillPoints, portrait, skills = {}, gender } = character;
    const currentScene = storyLog[storyLog.length - 1];

    useEffect(() => {
        if (audioUrl && audioRef.current) {
            audioRef.current.play();
        }
    }, [audioUrl]);

    const handlePlayAudio = async (text: string) => {
        if (isSpeaking) {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.currentTime = 0;
            }
            setIsSpeaking(false);
            setAudioUrl(null);
            return;
        }

        setIsSpeaking(true);

        try {
            const payload = {
                contents: [{
                    parts: [{ text: `Say in a clear, narrative voice: ${text}` }]
                }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: gender === 'Male' ? 'Kore' : 'Puck' }
                        }
                    }
                },
                model: "gemini-2.5-flash-preview-tts"
            };
            const apiKey = process.env.API_KEY || "";
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`API request failed with status ${response.status}`);
            }

            const result = await response.json();
            const part = result?.candidates?.[0]?.content?.parts?.[0];
            const audioData = part?.inlineData?.data;
            const mimeType = part?.inlineData?.mimeType;

            if (audioData && mimeType && mimeType.startsWith("audio/")) {
                const sampleRateMatch = mimeType.match(/rate=(\d+)/);
                const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 24000;
                const pcmData = base64ToArrayBuffer(audioData);
                const pcm16 = new Int16Array(pcmData);
                const wavBlob = pcmToWav(pcm16, sampleRate);
                const newAudioUrl = URL.createObjectURL(wavBlob);
                setAudioUrl(newAudioUrl);
            } else {
                throw new Error("Invalid audio data in API response");
            }
        } catch (error) {
            console.error("TTS generation failed:", error);
            setIsSpeaking(false);
        }
    };

    return (
        <div className="game-container">
            <audio
                ref={audioRef}
                src={audioUrl || ''}
                onEnded={() => {
                    setIsSpeaking(false);
                    setAudioUrl(null);
                }}
                onError={() => {
                    setIsSpeaking(false);
                    setAudioUrl(null);
                }}
            />
            <header className="game-header">
                <h1><img src="/ea-logo.png" />&nbsp;Endless Adventure</h1>
                <button onClick={onNewGame} className="new-game-btn">Start New Game</button>
            </header>
            <main className="game-main">
                <div className="character-panel">
                    <img src={portrait} alt={`${name}'s portrait`} className="character-portrait" />
                    <h2>{name}</h2>
                    <div className="stats-grid">
                        <div className="stat-item">
                            <span className="stat-label">HP</span>
                            <span className="stat-value">{hp}</span>
                        </div>
                         <div className="stat-item">
                            <span className="stat-label">XP</span>
                            <span className="stat-value">{xp}</span>
                        </div>
                    </div>

                    {skillPoints > 0 && (
                        <button onClick={onLevelUp} className="level-up-btn">
                            Level Up ({skillPoints} Points)
                        </button>
                    )}

                    <h3>Skills</h3>
                    <ul className="skills-list">
                        {Object.entries(skills).sort(([, lvlA], [, lvlB]) => lvlB - lvlA).map(([skill, level]) => (
                            <li key={skill}>{skill} <span className="skill-level">Lvl {level}</span></li>
                        ))}
                    </ul>


                    <h3>Party</h3>
                    <ul className="skills-list">
                        {companions.length > 0 ? (
                            companions.map(companion => (
                                <li key={companion.name}>
                                    <span>{companion.name}</span>
                                    <span className="skill-level" title={`Relationship: ${companion.relationship}`}>
                                        {companion.relationship >= 50 ? 'Ally' : companion.relationship <= -50 ? 'Rival' : 'Neutral'}
                                    </span>
                                </li>
                            ))
                        ) : (
                            <li>No party members yet.</li>
                        )}
                    </ul>
                </div>
                <div className="story-panel">
                    <div className="illustration-container">
                       {isLoading && <div className="illustration-loader"><Loader text="Drawing next scene..."/></div>}
                       <img src={currentScene.illustration} alt="Current scene" className={`story-illustration ${isLoading ? 'loading' : ''}`} />
                    </div>
                    <div className="story-text">
                        <button
                            className="play-audio-btn"
                            onClick={() => handlePlayAudio(currentScene.text)}
                            aria-label={isSpeaking ? 'Stop narration' : 'Play narration'}
                            disabled={isSpeaking && !audioUrl} // Disable if currently fetching audio
                        >
                            {isSpeaking ? '⏹️' : '▶️'}
                        </button>
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
    companions: [],
    storyLog: [],
    currentActions: [],
    storyGuidance: null,
    skillPools: null,
    gameStatus: 'initial_load',
    weather: 'Clear Skies',
    timeOfDay: 'Morning',
  });
  const [creationData, setCreationData] = useState<CreationData | null>(null);
  const [apiIsLoading, setApiIsLoading] = useState(false);
  const [isCustomActionModalOpen, setIsCustomActionModalOpen] = useState(false);

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

  const handleNewGame = useCallback(() => {
      Preferences.remove({ key: 'endlessAdventureSave' });
      setCreationData(null);
      setGameState(prevState => ({
        ...prevState, // Keep existing state properties
        character: null,
        companions: [],
        storyLog: [],
        currentActions: [],
        storyGuidance: null,
        skillPools: null,
        weather: 'Clear Skies',
        timeOfDay: 'Morning',
        gameStatus: 'characterCreation',
      }));
  }, [setGameState, setCreationData]); // Add dependencies

  // Load from device storage on startup
  useEffect(() => {
    const loadGame = async () => {
      try {
        const ret = await Preferences.get({ key: 'endlessAdventureSave' });
        if (ret.value) {
          const { gameState: savedGameState, creationData: savedCreationData } = JSON.parse(ret.value);

          if (savedGameState.character && savedGameState.gameStatus === 'playing' && !savedGameState.character.portrait) {
            const [portrait, illustration] = await Promise.all([
              generateImage(savedGameState.character.description),
              generateImage(`${savedGameState.storyGuidance.setting}. ${savedGameState.storyLog[savedGameState.storyLog.length - 1].text}`)
            ]);
            savedGameState.character.portrait = portrait;
            savedGameState.storyLog[savedGameState.storyLog.length - 1].illustration = illustration;
          }

          // IMPORTANT: Merge with defaults to prevent errors from old saves
          setGameState(prevState => ({
              ...prevState,
              ...savedGameState
          }));

          if (savedCreationData) {
            setCreationData(savedCreationData);
          }

        } else {
          // If there's no save file, start a new game.
          handleNewGame();
        }
      } catch (error) {
        console.error("Failed to load or parse saved state, starting new game:", error);
        // If the save file is corrupted, start a new game.
        handleNewGame();
      }
    };

    loadGame();
  }, [generateImage, handleNewGame]);

  // Save to device storage on change
  useEffect(() => {
    const saveGame = async () => {
      if (gameState.gameStatus !== 'initial_load' && gameState.gameStatus !== 'loading') {
        const stateToSave = {
          ...gameState,
          character: gameState.character
            ? { ...gameState.character, portrait: '' }
            : null,
          storyLog: gameState.storyLog.map((segment, index) => {
            if (index === gameState.storyLog.length - 1) {
              return segment;
            }
            return { ...segment, illustration: '' };
          }),
        };
        await Preferences.set({
          key: 'endlessAdventureSave',
          value: JSON.stringify({ gameState: stateToSave, creationData })
        });
      }
    };
    saveGame();
  }, [gameState, creationData]);

  const handleCreateCharacter = useCallback(async (details: CreationDetails) => {
    setApiIsLoading(true);
    setGameState(g => ({...g, gameStatus: 'loading'}));

    const { name, gender, race, characterClass, background, campaign } = details;

    try {
        const prompt = `
            Generate a fantasy character, story guidance, skill pools, and an opening scene for a text adventure game.
            The player has defined their character with the following attributes:
            - Name: '${name}'
            - Gender: ${gender}
            - Race: ${race}
            - Class: ${characterClass}
            - Background: ${background}
            - Desired Campaign Type: ${campaign}

            Base the character's description, the initial story, the plot, and the available skill pools on all of these attributes, especially the Desired Campaign Type. For example, a 'Revenge Story' should start with an event that gives the character a reason for vengeance. Ensure the character description is detailed and suitable for generating a portrait.
        `;
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: characterGenSchema,
            },
            safetySettings: safetySettings,
        });

        const responseText = await response.response.text();
        const data = JSON.parse(responseText);


        const initialCompanions: Companion[] = data.companions.map((comp: any) => {
            const skillsObject = comp.skills.reduce((acc: { [key: string]: number }, skill: { skillName: string, level: number }) => {
                acc[skill.skillName] = skill.level;
                return acc;
            }, {});

            return {
                ...comp,
                skills: skillsObject,
                relationship: 0
            };
        });


        setCreationData({
            name: data.character.name,
            gender: details.gender,
            description: data.character.description,
            storyGuidance: data.storyGuidance,
            initialStory: data.initialStory,
            skillPools: data.skillPools,
            startingSkillPoints: data.startingSkillPoints
        });
        setGameState(g => ({...g, companions: initialCompanions, gameStatus: 'characterCustomize'}));

    } catch (error) {
        console.error("Character creation failed:", error);
        handleNewGame();
    } finally {
        setApiIsLoading(false);
    }
  }, [handleNewGame]);

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
            gender: creationData.gender,
            hp: 100,
            xp: 0,
            skills: chosenSkills,
            skillPoints: 0,
            description: creationData.description,
            portrait: portrait,
            storySummary: "The adventure is just beginning...",
            reputation: {}
        };
        const initialSegment: StorySegment = { text: creationData.initialStory.text, illustration };

        setGameState(prevState => ({
            ...prevState,
            character: newCharacter,
            storyGuidance: creationData.storyGuidance,
            skillPools: creationData.skillPools,
            storyLog: [initialSegment],
            currentActions: creationData.initialStory.actions,
            gameStatus: 'playing'
        }));
        setCreationData(null); // Clean up temp data

     } catch (error) {
        console.error("Character finalization failed:", error);
        handleNewGame();
     } finally {
         setApiIsLoading(false);
     }
  }, [creationData, generateImage, handleNewGame]);


  const handleAction = useCallback(async (action: string) => {
      if (!gameState.character || !gameState.storyGuidance) return;
      setApiIsLoading(true);

      try {
          const storyHistory = gameState.storyLog.map(s => s.text).join('\n\n');
          const companionsDetails = gameState.companions.map(c =>
            `  - Name: ${c.name}, Personality: ${c.personality}, Relationship: ${c.relationship}`
          ).join('\n');
          const prompt = `
            Continue this text adventure.
            STORY GUIDANCE:
            Setting: ${gameState.storyGuidance.setting}
            Plot: ${gameState.storyGuidance.plot}

            CURRENT CONDITIONS:
            Time of Day: ${gameState.timeOfDay}
            Weather: ${gameState.weather}

            CHARACTER:
            Name: ${gameState.character.name}
            HP: ${gameState.character.hp}
            XP: ${gameState.character.xp}
            Reputation: ${JSON.stringify(gameState.character.reputation)}
            Companions:
            ${companionsDetails}
            Skills: ${Object.entries(gameState.character.skills).map(([skill, level]) => `${skill} (Lvl ${level})`).join(', ')}
            Description: ${gameState.character.description}

            CHARACTER STORY SUMMARY (What happened before the most recent events):
            ---
            ${gameState.character.storySummary || "The story is just beginning."}
            ---

            RECENT STORY SO FAR (The last 50 messages):
            ---
            ${storyHistory}
            ---

            PLAYER ACTION: "${action}"

            Generate the next part of the story based on the player's action. Update HP/XP if necessary. Provide new actions. Keep the story moving forward.
            Update companion relationships if their opinion of the player changes. If the story presents an opportunity, you can introduce a *new* character for the player to potentially recruit by populating the 'newCompanion' field.

          `;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: nextStepSchema,
            },
            safetySettings: safetySettings,
        });

        const responseText = await response.response.text();
        const data = JSON.parse(responseText).story;
        const newIllustration = await generateImage(`${gameState.storyGuidance.setting}. ${data.text}`);
        const newSegment: StorySegment = { text: data.text, illustration: newIllustration };

        setGameState(prevState => {
            if (!prevState.character) return prevState;
            const oldXp = prevState.character.xp;
            const newXp = oldXp + data.didXpChange;
            const earnedSkillPoints = Math.floor(newXp / 100) - Math.floor(oldXp / 100);
            const newReputation = { ...prevState.character.reputation };
            if (data.reputationChange) {
                for (const [faction, change] of Object.entries(data.reputationChange)) {
                    newReputation[faction] = (newReputation[faction] || 0) + (change as number);
                }
            }
            const updatedCharacter = {
                ...prevState.character,
                hp: prevState.character.hp + data.didHpChange,
                xp: newXp,
                skillPoints: prevState.character.skillPoints + earnedSkillPoints,
                reputation: newReputation
            };


            const updatedCompanions = [...prevState.companions];
            if (data.companionUpdates) {
                for (const update of data.companionUpdates) {
                    const companionIndex = updatedCompanions.findIndex(c => c.name === update.name);
                    if (companionIndex !== -1) {
                        updatedCompanions[companionIndex].relationship += update.relationshipChange;
                    }
                }
            }

            if (data.newCompanion && action.toLowerCase().includes(`recruit ${data.newCompanion.name.toLowerCase()}`)) {
                 if (updatedCompanions.length < 5) {
                    const skillsObject = data.newCompanion.skills.reduce((acc: { [key: string]: number }, skill: { skillName: string, level: number }) => {
                        acc[skill.skillName] = skill.level;
                        return acc;
                    }, {});

                     const companionToAdd: Companion = {
                         ...data.newCompanion,
                         skills: skillsObject,
                         relationship: 20
                     };
                     updatedCompanions.push(companionToAdd);
                 }
            }

            return {
                ...prevState,
                character: updatedCharacter,
                companions: updatedCompanions,
                weather: data.newWeather,
                timeOfDay: data.newTimeOfDay,
                storyLog: [...prevState.storyLog, newSegment].slice(-100),
                currentActions: data.actions,
            };
        });

        const newStoryLogLength = gameState.storyLog.length + 1;
        if (newStoryLogLength > 0 && newStoryLogLength % 10 === 0) {
            const oldSummary = gameState.character?.storySummary || "The story has just begun.";
            const recentEvents = [...gameState.storyLog, newSegment].slice(-10).map(s => s.text).join('\n\n');

            const summaryPrompt = `
                You are a master storyteller. Update the character's story summary based on the previous summary and recent events.
                - 40% importance on the "PREVIOUS SUMMARY".
                - 60% importance on the "RECENT EVENTS".
                Weave the new events into the existing narrative to create a new, cohesive summary.

                PREVIOUS SUMMARY:
                ---
                ${oldSummary}
                ---

                RECENT EVENTS:
                ---
                ${recentEvents}
                ---

                Generate the new, complete summary.
            `;

            const summaryResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: [{ parts: [{ text: summaryPrompt }] }],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: storySummarySchema,
                },
                safetySettings: safetySettings
            });
            const summaryText = await summaryResponse.response.text();
            const summaryData = JSON.parse(summaryText);

            setGameState(prevState => {
                if (!prevState.character) return prevState;
                return {
                    ...prevState,
                    character: {
                        ...prevState.character,
                        storySummary: summaryData.summary
                    }
                };
            });
        }

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
