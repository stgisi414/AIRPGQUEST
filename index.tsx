import React, { useState, useEffect, useCallback, useRef, FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Type } from "@google/genai";
import './game.css';
import { initializeApp } from "firebase/app";
import { 
  getAuth, 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User 
} from "firebase/auth";
import { 
  getFirestore, 
  initializeFirestore,
  doc, 
  setDoc, 
  getDoc,
  getDocs,
  deleteDoc,
  onSnapshot, 
  collection, 
  addDoc, 
  updateDoc,
  arrayUnion,
  serverTimestamp,
  Timestamp
} from "firebase/firestore";
import { 
  getStorage, 
  ref, 
  uploadString, 
  getDownloadURL 
} from "firebase/storage";

// REPLACE WITH YOUR FIREBASE CONFIG
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { ignoreUndefinedProperties: true });
const storage = getStorage(app);
const googleProvider = new GoogleAuthProvider();

// --- HELPER FUNCTION (MUST BE HERE, OUTSIDE APP) ---
const uploadImageToStorage = async (base64Data: string, path: string): Promise<string> => {
    if (!base64Data || !base64Data.startsWith('data:image')) return base64Data;
    
    try {
        const storageRef = ref(storage, path);
        await uploadString(storageRef, base64Data, 'data_url');
        return await getDownloadURL(storageRef);
    } catch (error) {
        console.error("Upload failed:", error);
        // Important: If upload fails (e.g. permissions), we return the base64.
        // This causes the Firestore "Document too large" error, which is expected
        // until permissions are fixed in Step 1.
        return base64Data; 
    }
};

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
interface SavedGame {
    id: string;
    name: string;
    characterClass: string;
    level: number;
    lastPlayed: any;
    gameState: GameState;
}

interface CharacterStats {
    str: number;
    dex: number;
    con: number;
    wis: number;
    cha: number;
    int: number;
}

// 2. Update Character Interface
interface Character {
  name: string;
  gender: string;
  hp: number;
  maxHp: number;
  xp: number;
  skills: { [key: string]: number };
  skillPoints: number;
  // --- ADDED STATS ---
  stats: CharacterStats;
  // -------------------
  description: string;
  portrait: string | null; 
  storySummary?: string;
  reputation: { [key: string]: number };
  alignment: Alignment;
  equipment: {
    weapon: Equipment | null;
    armor: Equipment | null;
    gear: Equipment[] | null;
  };
  gold: number;
}

interface StorySegment {
  text: string;
  illustration: string | null; // base64 image
  skillCheck?: {
    skillName: string;
    success: boolean;
    difficulty: string;
  };
}

interface Skill {
  name: string;
  description: string;
}

type SkillPools = { [key: string]: Skill[] }; // Was string[]

interface Companion {
  name: string;
  description: string;
  skills: { [key: string]: number };
  personality: string; // e.g., "Loyal but cautious," "Brave and reckless"
  alignment: Alignment;
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
  gameStatus: 'characterCreation' | 'characterCustomize' | 'levelUp' | 'playing' | 'loading' | 'initial_load' | 'combat' | 'gameOver' | 'looting' | 'transaction' | 'gambling';
  weather: string;
  timeOfDay: string;
  combat: CombatState | null;
  loot: Loot | null;
  transaction: TransactionState | null;
  map: MapState | null;
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
    startingEquipment: any;
    background: string;
    startingAlignment: Alignment;
    startingStats: CharacterStats;
    startingMap: {
        locations: Omit<MapLocation, 'visited'>[];
        startingLocationName: string;
    };
    characterClass?: string;
}

interface Player {
    uid: string;
    displayName: string;
    characterName?: string;
    isHost: boolean;
    isReady: boolean;
}

interface MultiplayerLobby {
    id: string;
    hostUid: string;
    name: string;
    players: Player[];
    status: 'waiting' | 'playing' | 'finished';
    currentTurnIndex: number;
    turnDeadline: Timestamp;
    gameState: GameState; // The shared game state
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

interface Equipment {
  name: string;
  description: string;
  stats: {
    damage?: number;
    damageReduction?: number;
  };
  value: number;
}

// --- COMBAT TYPES ---
interface Enemy {
    id: string;
    name: string;
    hp: number;
    maxHp: number;
    description: string;
    portrait: string | null; // base64 image
}

interface CombatLogEntry {
    type: 'player' | 'enemy' | 'info';
    message: string;
}

interface CombatState {
    enemies: Enemy[];
    log: CombatLogEntry[];
    turn: 'player' | 'enemy';
    availableActions: string[];
}

interface Loot {
    gold: number;
    items: Equipment[];
}

interface TransactionState {
    vendorName: string;
    vendorDescription: string;
    vendorPortrait: string | null;
    inventory: Equipment[];
}

// --- MAP TYPES ---
interface MapLocation {
    name: string;
    x: number; // Percentage from left
    y: number; // Percentage from top
    visited: boolean;
    description: string; // A prompt for image generation
}

interface MapState {
    backgroundImage: string | null;
    locations: MapLocation[];
}

interface Alignment {
    lawfulness: number; // -100 (Chaotic) to 100 (Lawful)
    goodness: number;  // -100 (Evil) to 100 (Good)
}

const PROXY_URLS = {
    gemini: "https://us-central1-airpgquest.cloudfunctions.net/geminiProxy",
    imagen: "https://us-central1-airpgquest.cloudfunctions.net/imagenProxy" 
};

const callGemini = async (model: string, contents: any, config: any) => {
    const response = await fetch(PROXY_URLS.gemini, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, contents, config })
    });
    if (!response.ok) throw new Error('Gemini Proxy Failed');
    return await response.json();
};

const callImagen = async (model: string, prompt: string, config: any) => {
    const response = await fetch(PROXY_URLS.imagen, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, config })
    });
    if (!response.ok) throw new Error('Imagen Proxy Failed');
    return await response.json();
};

// --- API SCHEMAS ---
const characterGenSchema = {
  type: Type.OBJECT,
  properties: {
    character: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        description: { type: Type.STRING, description: "A detailed physical and personality description of the character, suitable for generating a portrait image." },
        alignment: {
            type: Type.OBJECT,
            properties: {
                lawfulness: { type: Type.INTEGER },
                goodness: { type: Type.INTEGER }
            },
            required: ['lawfulness', 'goodness']
        }
      },
      required: ['name', 'description', 'alignment']
    },
    companions: {
      type: Type.ARRAY,
      description: "An array of 1-2 starting companions for the player's party. Give each a unique name, description, personality, and skills.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          alignment: {
            type: Type.OBJECT,
            properties: {
                lawfulness: { type: Type.INTEGER, description: "Initial lawfulness score (-100 to 100)." },
                goodness: { type: Type.INTEGER, description: "Initial goodness score (-100 to 100)." }
            },
            required: ['lawfulness', 'goodness']
          },
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
            },

          },
          startingEquipment: {
              type: Type.OBJECT,
              properties: {
                  weapon: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, description: { type: Type.STRING }, stats: { type: Type.OBJECT, properties: { damage: { type: Type.INTEGER } } }, value: { type: Type.INTEGER } }, required: ['name', 'description', 'stats', 'value'] },
                  armor: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, description: { type: Type.STRING }, stats: { type: Type.OBJECT, properties: { damageReduction: { type: Type.INTEGER } } }, value: { type: Type.INTEGER } }, required: ['name', 'description', 'stats', 'value'] },
                  gear: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, description: { type: Type.STRING }, stats: { type: Type.OBJECT, properties: { damage: { type: Type.INTEGER, nullable: true }, damageReduction: { type: Type.INTEGER, nullable: true } } }, value: { type: Type.INTEGER } }, required: ['name', 'description', 'stats', 'value'] } }
              },
              required: ['weapon', 'armor', 'gear']
          }
        },
        required: ['name', 'description', 'personality', 'skills', 'startingEquipment']
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
        description: "Three pools of skills...",
        properties: {
            // --- UPDATE PROPERTIES TO OBJECTS WITH DESCRIPTION ---
            Combat: { 
                type: Type.ARRAY, 
                items: { 
                    type: Type.OBJECT, 
                    properties: { name: { type: Type.STRING }, description: { type: Type.STRING } }, 
                    required: ['name', 'description'] 
                } 
            },
            Magic: { 
                type: Type.ARRAY, 
                items: { 
                    type: Type.OBJECT, 
                    properties: { name: { type: Type.STRING }, description: { type: Type.STRING } }, 
                    required: ['name', 'description'] 
                } 
            },
            Utility: { 
                type: Type.ARRAY, 
                items: { 
                    type: Type.OBJECT, 
                    properties: { name: { type: Type.STRING }, description: { type: Type.STRING } }, 
                    required: ['name', 'description'] 
                } 
            },
            // -----------------------------------------------------
        },
        required: ['Combat', 'Magic', 'Utility']
    },
    startingSkillPoints: { type: Type.INTEGER, description: "The number of points the player can initially spend on skills. Usually 5-7."},
    startingEquipment: {
      type: Type.OBJECT,
      properties: {
          weapon: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, description: { type: Type.STRING }, stats: { type: Type.OBJECT, properties: { damage: { type: Type.INTEGER } } }, value: { type: Type.INTEGER } }, required: ['name', 'description', 'stats', 'value'] },
          armor: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, description: { type: Type.STRING }, stats: { type: Type.OBJECT, properties: { damageReduction: { type: Type.INTEGER } } }, value: { type: Type.INTEGER } }, required: ['name', 'description', 'stats', 'value'] },
          gear: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, description: { type: Type.STRING }, stats: { type: Type.OBJECT, properties: { damage: { type: Type.INTEGER, nullable: true }, damageReduction: { type: Type.INTEGER, nullable: true } } }, value: { type: Type.INTEGER } }, required: ['name', 'description', 'stats', 'value'] } }
      },
      required: ['weapon', 'armor', 'gear']
    },
    map: {
        type: Type.OBJECT,
        description: "The initial state of the world map.",
        properties: {
            locations: {
                type: Type.ARRAY,
                description: "An array of 5-7 starting locations on the map.",
                items: {
                    type: Type.OBJECT,
                    properties: {
                        name: { type: Type.STRING },
                        x: { type: Type.INTEGER, description: "X-coordinate (percentage from left, 0-100)" },
                        y: { type: Type.INTEGER, description: "Y-coordinate (percentage from top, 0-100)" },
                        description: { type: Type.STRING }
                    },
                    required: ['name', 'x', 'y', 'description']
                }
            },
            startingLocationName: { type: Type.STRING, description: "The name of the location from the list where the story begins." }
        },
        required: ['locations', 'startingLocationName']
    }
  },
  required: ['character', 'storyGuidance', 'initialStory', 'skillPools', 'startingSkillPoints', 'companions', 'startingEquipment', 'map']
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
                alignmentChange: {
                    type: Type.OBJECT,
                    description: "How the player's action affects their alignment. Omit if no change.",
                    nullable: true,
                    properties: {
                        lawfulness: { type: Type.INTEGER, description: "Change in lawfulness (e.g., -5 for a chaotic act)." },
                        goodness: { type: Type.INTEGER, description: "Change in goodness (e.g., 10 for a good act)." }
                    },
                    required: ['lawfulness', 'goodness']
                },
                initiateCombat: { type: Type.BOOLEAN, description: "Set to true if the story should now transition into a combat encounter."},
                enemies: {
                    type: Type.ARRAY,
                    description: "If initiateCombat is true, provide an array of enemies. Otherwise, this should be null.",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            name: { type: Type.STRING },
                            description: { type: Type.STRING, description: "A detailed description suitable for generating a portrait image."},
                            hp: { type: Type.INTEGER }
                        },
                        required: ['name', 'description', 'hp']
                    }
                },
                initiateTransaction: {
                    type: Type.BOOLEAN,
                    description: "Set to true to start a transaction with an NPC."
                },
                transaction: {
                    type: Type.OBJECT,
                    description: "If initiateTransaction is true, provide vendor details.",
                    nullable: true,
                    properties: {
                        vendorName: { type: Type.STRING },
                        vendorDescription: { type: Type.STRING, description: "A description of the vendor suitable for a portrait."},
                        inventory: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: { type: Type.STRING },
                                    description: { type: Type.STRING },
                                    stats: { type: Type.OBJECT, properties: { damage: { type: Type.INTEGER, nullable: true }, damageReduction: { type: Type.INTEGER, nullable: true } } },
                                    value: { type: Type.INTEGER }
                                },
                                required: ['name', 'description', 'stats', 'value']
                            }
                        }
                    }
                },
                mapUpdate: {
                    type: Type.OBJECT,
                    description: "Updates to the world map. Can include new locations or updating existing ones.",
                    nullable: true,
                    properties: {
                        newLocations: {
                            type: Type.ARRAY,
                            description: "A list of new locations to add to the map.",
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: { type: Type.STRING },
                                    x: { type: Type.INTEGER, description: "X-coordinate (percentage from left, 0-100)" },
                                    y: { type: Type.INTEGER, description: "Y-coordinate (percentage from top, 0-100)" },
                                    description: { type: Type.STRING, description: "A detailed visual description of the location for generating an image." }
                                },
                                required: ['name', 'x', 'y', 'description']
                            }
                        },
                        updateVisited: {
                            type: Type.STRING,
                            description: "The name of the location the player has just visited.",
                            nullable: true
                        }
                    }
                },
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
                    description: "If a new companion can be recruited in this story segment, describe them here. Otherwise, this should be null. NOTE: If the player recruits a previously mentioned character, still use this field to return their full data.",
                    nullable: true,
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
                newTimeOfDay: { type: Type.STRING, description: "The new time of day (e.g., 'Morning', 'Afternoon', 'Night')." },
                equipmentUpdates: {
                    type: Type.ARRAY,
                    description: "An array of equipment updates. Each object specifies the slot and the new equipment to be assigned.",
                    nullable: true,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            slot: { type: Type.STRING, description: "The equipment slot to update (e.g., 'weapon', 'armor', or 'gear')." },
                            name: { type: Type.STRING, description: "The new name for the equipment." },
                            description: { type: Type.STRING, description: "The new description for the equipment." },
                            stats: { type: Type.OBJECT, properties: { damage: { type: Type.INTEGER, nullable: true }, damageReduction: { type: Type.INTEGER, nullable: true } } },
                            action: { type: Type.STRING, description: "The action to perform on the equipment (e.g., 'add', 'remove', 'replace', 'update')." }
                        },
                        required: ['slot', 'name', 'description', 'stats', 'action']
                    }
                },
                skillCheck: {
                    type: Type.OBJECT,
                    description: "Details of a skill check performed. Only include if a skill check was triggered by the player's action.",
                    nullable: true,
                    properties: {
                        skillName: { type: Type.STRING, description: "The name of the skill being tested (e.g., 'Swordsmanship')." },
                        success: { type: Type.BOOLEAN, description: "True if the skill check was successful, false otherwise." },
                        difficulty: { type: Type.STRING, description: "A brief description of the difficulty (e.g., 'Moderate', 'Challenging')." },
                    },
                    required: ['skillName', 'success', 'difficulty']
                }
            },
            required: ['text', 'actions', 'didHpChange', 'didXpChange', 'initiateCombat', 'enemies', 'companionUpdates', 'newCompanion', 'reputationChange', 'newWeather', 'newTimeOfDay', 'mapUpdate']
        }
    },
    required: ['story']
}

const combatActionSchema = {
    type: Type.OBJECT,
    properties: {
        combatResult: {
            type: Type.OBJECT,
            properties: {
                log: {
                    type: Type.ARRAY,
                    description: "A list of events that occurred this turn, as strings. e.g., ['You swing your sword at the Goblin.', 'You hit for 12 damage.', 'The Goblin attacks you.', 'You take 5 damage.']",
                    items: { type: Type.STRING }
                },
                playerHpChange: { type: Type.INTEGER, description: "The total HP change for the player this turn." },
                enemyHpChanges: {
                    type: Type.ARRAY,
                    description: "An array of HP changes for each enemy.",
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            id: { type: Type.STRING, description: "The ID of the enemy whose HP changed." },
                            hpChange: { type: Type.INTEGER, description: "The amount of HP the enemy lost (negative number)." }
                        },
                        required: ['id', 'hpChange']
                    }
                },
                availableActions: {
                    type: Type.ARRAY,
                    description: "A new list of 3-4 available actions for the player's next turn.",
                    items: { type: Type.STRING }
                },
                combatOver: { type: Type.BOOLEAN, description: "Set to true if all enemies have been defeated." },
                victoryText: { type: Type.STRING, description: "If combat is over, a short text describing the victory. e.g., 'You stand victorious over the defeated goblins.'", nullable: true },
                xpGained: { type: Type.INTEGER, description: "If combat is over, the amount of XP gained.", nullable: true },
                loot: {
                    type: Type.OBJECT,
                    description: "Gold and items dropped by the defeated enemies.",
                    nullable: true,
                    properties: {
                        gold: { type: Type.INTEGER },
                        items: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    name: { type: Type.STRING },
                                    description: { type: Type.STRING },
                                    stats: { type: Type.OBJECT, properties: { damage: { type: Type.INTEGER, nullable: true }, damageReduction: { type: Type.INTEGER, nullable: true } } },
                                    value: { type: Type.INTEGER }
                                },
                                required: ['name', 'description', 'stats', 'value']
                            }
                        }
                    }
                }
            },
            required: ['log', 'playerHpChange', 'enemyHpChanges', 'availableActions', 'combatOver']
        }
    },
    required: ['combatResult']
};

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

const mapGenSchema = {
    type: Type.OBJECT,
    properties: {
        locations: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING },
                    x: { type: Type.INTEGER, description: "X-coordinate (percentage from left, 0-100)" },
                    y: { type: Type.INTEGER, description: "Y-coordinate (percentage from top, 0-100)" },
                    description: { type: Type.STRING }
                },
                required: ['name', 'x', 'y', 'description']
            }
        }
    },
    required: ['locations']
};

const imagePromptSchema = {
    type: Type.OBJECT,
    properties: {
        prompt: {
            type: Type.STRING,
            description: "A concise, sanitized, and effective image generation prompt, focusing on key visual elements for fantasy art."
        }
    },
    required: ['prompt']
};

const alignmentSyncSchema = {
    type: Type.OBJECT,
    properties: {
        playerAlignment: {
            type: Type.OBJECT,
            properties: {
                lawfulness: { type: Type.INTEGER },
                goodness: { type: Type.INTEGER }
            },
            required: ['lawfulness', 'goodness']
        },
        companionAlignments: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING },
                    lawfulness: { type: Type.INTEGER },
                    goodness: { type: Type.INTEGER }
                },
                required: ['name', 'lawfulness', 'goodness']
            }
        }
    },
    required: ['playerAlignment', 'companionAlignments']
};

const riddleSchema = {
  type: Type.OBJECT,
  properties: {
    question: { type: Type.STRING },
    answer: { type: Type.STRING }
  },
  required: ['question', 'answer']
};

const runeSchema = {
  type: Type.OBJECT,
  properties: {
    outcome: {
      type: Type.STRING,
      enum: ["nothing", "win_gold", "lose_gold", "win_item"]
    },
    multiplier: {
      type: Type.NUMBER,
      description: "Only if win_gold, e.g., 1.5 to 5.0"
    },
    item: {
      type: Type.OBJECT,
      nullable: true,
      description: "Only if win_item",
      properties: {
        name: { type: Type.STRING },
        description: { type: Type.STRING },
        stats: {
          type: Type.OBJECT,
          properties: {
            damage: { type: Type.INTEGER, nullable: true },
            damageReduction: { type: Type.INTEGER, nullable: true }
          }
        },
        value: { type: Type.INTEGER }
      },
      required: ['name', 'description', 'stats', 'value']
    },
    narrative: {
      type: Type.STRING,
      description: "A mystical description of the runes' reading."
    }
  },
  required: ['outcome', 'narrative']
};

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

const StatAllocator = ({ 
    stats, 
    pointsRemaining, 
    onStatChange, 
    isCreation = false 
}: { 
    stats: CharacterStats, 
    pointsRemaining: number, 
    onStatChange: (stat: keyof CharacterStats, value: number) => void,
    isCreation?: boolean
}) => {
    const statNames: (keyof CharacterStats)[] = ['str', 'dex', 'con', 'wis', 'cha', 'int'];
    const descriptions = {
        str: "Melee Damage (+1 dmg / 2 lvls above 8)",
        dex: "Ranged Dmg & Enemy Miss Chance",
        con: "HP Bonus per Level",
        wis: "Magic Damage (+1 dmg / 2 lvls above 8)",
        cha: "Better Buy/Sell Prices",
        int: "+1 Skill Point / 4 lvls per Level Up"
    };

    return (
        <div className="flex flex-col gap-4 bg-[#181611] p-4 rounded-lg border border-[#544c3b]">
            <div className="flex justify-between items-center mb-2">
                <h3 className="text-white font-bold text-lg font-display">Attributes</h3>
                <span className="text-primary font-mono font-bold">Points: {pointsRemaining}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {statNames.map(stat => (
                    <div key={stat} className="flex flex-col gap-1 p-2 bg-white/5 rounded border border-white/10">
                        <div className="flex justify-between items-center">
                            <span className="text-white font-bold uppercase tracking-wider text-sm">{stat}</span>
                            <span className="text-white font-mono text-lg">{stats[stat]}</span>
                        </div>
                        <div className="text-[#bab09c] text-xs mb-2 min-h-[20px]">{descriptions[stat]}</div>
                        <div className="flex gap-2">
                            <button 
                                type="button"
                                onClick={() => onStatChange(stat, -1)}
                                // In creation, min is 0. In level up, min is current value (handled by parent logic usually, but here we just check > 0)
                                disabled={stats[stat] <= 0} 
                                className="flex-1 bg-white/10 hover:bg-white/20 text-white rounded px-2 py-1 disabled:opacity-30"
                            >-</button>
                            <button 
                                type="button"
                                onClick={() => onStatChange(stat, 1)}
                                disabled={pointsRemaining <= 0}
                                className="flex-1 bg-primary/20 hover:bg-primary/40 text-primary rounded px-2 py-1 disabled:opacity-30"
                            >+</button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

const CharacterCreationScreen = ({ onCreate, isLoading }: { onCreate: (details: CreationDetails & { stats: CharacterStats }) => void, isLoading: boolean }) => {
  const [name, setName] = useState('');
  const [gender, setGender] = useState('Male');
  const [race, setRace] = useState(RACES[0]);
  const [characterClass, setCharacterClass] = useState(CLASSES[0]);
  const [background, setBackground] = useState(BACKGROUNDS[0]);
  const [campaign, setCampaign] = useState(CAMPAIGN_TYPES[0]);

  const [stats, setStats] = useState<CharacterStats>({ str: 0, dex: 0, con: 0, wis: 0, cha: 0, int: 0 });
  const [points, setPoints] = useState(42);

  const handleStatChange = (stat: keyof CharacterStats, change: number) => {
      if (change > 0 && points <= 0) return;
      if (change < 0 && stats[stat] <= 0) return;
      
      setStats(prev => ({ ...prev, [stat]: prev[stat] + change }));
      setPoints(prev => prev - change);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
        // Pass stats to onCreate
        onCreate({ name: name.trim(), gender, race, characterClass, background, campaign, stats });
    }
  };

  // Custom select arrow SVG for Tailwind
  const selectArrow = `url("data:image/svg+xml,%3csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2724px%27 height=%2724px%27 fill=%27rgb(186,176,156)%27 viewBox=%270 0 256 256%27%3e%3cpath d=%27M181.66,170.34a8,8,0,0,1,0,11.32l-48,48a8,8,0,0,1-11.32,0l-48-48a8,8,0,0,1,11.32-11.32L128,212.69l42.34-42.35A8,8,0,0,1,181.66,170.34Zm-96-84.68L128,43.31l42.34,42.35a8,8,0,0,0,11.32-11.32l-48-48a8,8,0,0,0-11.32,0l-48-48A8,8,0,0,0,85.66,85.66Z%27%3e%3c/path%3e%3c/svg%3e")`;

  return (
    <div className="relative flex h-auto min-h-screen w-full flex-col bg-background-dark group/design-root overflow-x-hidden font-display">
      <div className="absolute inset-0 z-0">
        <img 
            className="h-full w-full object-cover opacity-20" 
            alt="Background" 
            src="https://images.unsplash.com/photo-1519074069444-1ba4fff66d16?q=80&w=2574&auto=format&fit=crop"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background-dark via-background-dark/80 to-transparent"></div>
      </div>

      <div className="relative z-10 flex h-full grow flex-col">
        <div className="flex flex-1 items-center justify-center p-4 py-10 sm:p-6 md:p-8 lg:p-12">
          <div className="flex w-full max-w-2xl flex-col items-center gap-8 rounded-xl border border-[#544c3b]/50 bg-[#27231b]/80 p-6 shadow-2xl shadow-black/30 backdrop-blur-sm sm:p-8 md:p-10">
            
            <div className="flex flex-col gap-3 text-center">
              {/* --- REQUESTED TITLE KEPT --- */}
              <h1 className="text-white text-4xl font-black leading-tight tracking-[-0.033em] sm:text-5xl font-heading">Aethelgard's Echo</h1>
              <p className="text-[#bab09c] text-base font-normal leading-normal sm:text-lg">Forge Your Legend</p>
            </div>

            <form onSubmit={handleSubmit} className="flex w-full flex-col gap-6">
              
              {/* Name & Gender Row */}
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <label className="flex flex-col min-w-40 flex-1">
                  <p className="text-white text-base font-medium leading-normal pb-2">Your Name</p>
                  <input 
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={isLoading}
                    className="flex w-full min-w-0 flex-1 resize-none overflow-hidden rounded-lg text-white focus:outline-0 focus:ring-2 focus:ring-primary/50 border border-[#544c3b] bg-[#181611] focus:border-primary h-14 placeholder:text-[#bab09c] p-[15px] text-base font-normal leading-normal" 
                    placeholder="Enter your character's name" 
                  />
                </label>

                <div className="flex flex-col">
                  <p className="text-white text-base font-medium leading-normal pb-2">Gender</p>
                  <div className="flex flex-wrap gap-3">
                    {['Male', 'Female', 'Non-binary'].map((g) => (
                        <label key={g} className={`text-sm font-medium leading-normal flex items-center justify-center rounded-lg border border-[#544c3b] px-4 h-11 text-white relative cursor-pointer flex-1 text-center bg-[#181611] hover:border-primary/70 transition-all ${gender === g ? 'border-primary border-[2px] bg-primary/10' : ''}`}>
                            {g}
                            <input 
                                type="radio" 
                                name="gender" 
                                value={g} 
                                checked={gender === g} 
                                onChange={(e) => setGender(e.target.value)} 
                                className="invisible absolute"
                                disabled={isLoading}
                            />
                        </label>
                    ))}
                  </div>
                </div>
              </div>

              {/* Race & Class Row */}
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <label className="flex flex-col min-w-40 flex-1">
                  <p className="text-white text-base font-medium leading-normal pb-2">Race</p>
                  <select 
                    value={race} 
                    onChange={(e) => setRace(e.target.value)} 
                    disabled={isLoading}
                    style={{backgroundImage: selectArrow}}
                    className="appearance-none flex w-full min-w-0 flex-1 resize-none overflow-hidden rounded-lg text-white focus:outline-0 focus:ring-2 focus:ring-primary/50 border border-[#544c3b] bg-[#181611] focus:border-primary h-14 bg-no-repeat bg-[center_right_1rem] p-[15px] text-base font-normal leading-normal"
                  >
                    {RACES.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </label>
                <label className="flex flex-col min-w-40 flex-1">
                  <p className="text-white text-base font-medium leading-normal pb-2">Class</p>
                  <select 
                    value={characterClass} 
                    onChange={(e) => setCharacterClass(e.target.value)} 
                    disabled={isLoading}
                    style={{backgroundImage: selectArrow}}
                    className="appearance-none flex w-full min-w-0 flex-1 resize-none overflow-hidden rounded-lg text-white focus:outline-0 focus:ring-2 focus:ring-primary/50 border border-[#544c3b] bg-[#181611] focus:border-primary h-14 bg-no-repeat bg-[center_right_1rem] p-[15px] text-base font-normal leading-normal"
                  >
                    {CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>

              {/* Background & Campaign Row */}
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <label className="flex flex-col min-w-40 flex-1">
                  <p className="text-white text-base font-medium leading-normal pb-2">Background</p>
                  <select 
                    value={background} 
                    onChange={(e) => setBackground(e.target.value)} 
                    disabled={isLoading}
                    style={{backgroundImage: selectArrow}}
                    className="appearance-none flex w-full min-w-0 flex-1 resize-none overflow-hidden rounded-lg text-white focus:outline-0 focus:ring-2 focus:ring-primary/50 border border-[#544c3b] bg-[#181611] focus:border-primary h-14 bg-no-repeat bg-[center_right_1rem] p-[15px] text-base font-normal leading-normal"
                  >
                    {BACKGROUNDS.map(b => <option key={b} value={b}>{b}</option>)}
                  </select>
                </label>
                <label className="flex flex-col min-w-40 flex-1">
                  <p className="text-white text-base font-medium leading-normal pb-2">Campaign Type</p>
                  <select 
                    value={campaign} 
                    onChange={(e) => setCampaign(e.target.value)} 
                    disabled={isLoading}
                    style={{backgroundImage: selectArrow}}
                    className="appearance-none flex w-full min-w-0 flex-1 resize-none overflow-hidden rounded-lg text-white focus:outline-0 focus:ring-2 focus:ring-primary/50 border border-[#544c3b] bg-[#181611] focus:border-primary h-14 bg-no-repeat bg-[center_right_1rem] p-[15px] text-base font-normal leading-normal"
                  >
                    {CAMPAIGN_TYPES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>

              <StatAllocator 
                  stats={stats} 
                  pointsRemaining={points} 
                  onStatChange={handleStatChange} 
                  isCreation={true}
              />

              <div className="pt-4">
                <button 
                    type="submit" 
                    disabled={isLoading || !name.trim()}
                    className="flex h-14 w-full items-center justify-center rounded-lg bg-primary px-6 text-base font-bold text-background-dark shadow-lg shadow-primary/20 hover:bg-yellow-500 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background-dark disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {isLoading ? 'Conjuring World...' : 'Begin Your Journey'}
                </button>
              </div>

            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

const SkillDetailModal = ({ skill, onClose }: { skill: Skill | null, onClose: () => void }) => {
    if (!skill) return null;
    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200" onClick={onClose}>
            <div className="w-full max-w-sm rounded-xl border border-[#544c3b] bg-[#181611] p-6 shadow-2xl shadow-black/50" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-4 mb-4 border-b border-[#393328] pb-4">
                    <div className="text-primary flex items-center justify-center rounded-lg bg-[#221c10] shrink-0 size-12 border border-[#544c3b]">
                        <span className="material-symbols-outlined">auto_awesome</span>
                    </div>
                    <h3 className="text-xl font-bold text-white font-display">{skill.name}</h3>
                </div>
                <p className="text-[#bab09c] text-base leading-relaxed font-display">
                    {skill.description}
                </p>
                <button onClick={onClose} className="mt-6 w-full py-3 bg-primary text-background-dark font-bold rounded-lg hover:bg-yellow-500 transition-colors">
                    Close
                </button>
            </div>
        </div>
    );
};

const SkillAllocator = ({ 
    title, 
    skillPools, 
    availablePoints, 
    initialSkills = {}, 
    onComplete, 
    completeButtonText, 
    onCancel
}: { 
    title: string, 
    skillPools: SkillPools, 
    availablePoints: number, 
    initialSkills?: { [key: string]: number }, 
    onComplete: (skills: {[key: string]: number}) => void, 
    completeButtonText: string, 
    onCancel?: () => void 
}) => {
    const [skills, setSkills] = useState(initialSkills);
    const [points, setPoints] = useState(availablePoints);
    const [selectedSkill, setSelectedSkill] = useState<string | null>(null);

    const handleSkillChange = (skillName: string, change: number) => {
        const currentLevel = skills[skillName] || 0;
        const newLevel = currentLevel + change;

        if (change > 0 && points <= 0) return; // No points to spend
        if (newLevel < 0) return; // Cannot go below 0
        
        // If removing the last point, delete the key to keep state clean
        if (newLevel === 0 && currentLevel > 0) {
             const newSkills = {...skills};
             delete newSkills[skillName];
             setSkills(newSkills);
             setPoints(points + currentLevel);
        } else {
            setSkills(s => ({...s, [skillName]: newLevel}));
            setPoints(p => p - change);
        }
        setSelectedSkill(skillName); // Auto-select modified skill for info panel
    }

    // Helper to get icon based on category (Combat, Magic, Utility)
    const getCategoryIcon = (category: string) => {
        switch(category) {
            case 'Combat': return 'swords';
            case 'Magic': return 'auto_awesome'; // or 'spark'
            case 'Utility': return 'construction'; // or 'backpack'
            default: return 'star';
        }
    };

    return (
        <div className="relative flex min-h-screen w-full flex-col bg-background-light dark:bg-background-dark font-display overflow-hidden">
            <div className="flex flex-1 justify-center py-5 px-4 sm:px-8 md:px-12 lg:px-20 h-full overflow-hidden">
                <div className="flex w-full max-w-7xl flex-row gap-8 h-full">
                    
                    {/* Left Column: Stats Summary (Hidden on mobile for space, or stack it) */}
                    <aside className="hidden md:flex w-full max-w-[240px] flex-col gap-8">
                        <div className="flex min-w-[158px] flex-1 flex-col gap-2 rounded-xl p-6 border border-gray-200 dark:border-[#544c3b] bg-background-light dark:bg-[#221c10] h-min">
                            <p className="text-gray-800 dark:text-white text-base font-medium leading-normal">Skill Points Remaining</p>
                            <p className="text-primary tracking-light text-4xl font-bold leading-tight">{points}</p>
                        </div>
                        {/* Placeholder for character info if needed */}
                        <div className="flex flex-col gap-4 p-4 bg-background-light dark:bg-[#221c10] rounded-xl border border-transparent dark:border-[#544c3b]">
                            <div className="flex gap-3 items-center">
                                <div className="bg-center bg-no-repeat aspect-square bg-cover rounded-full size-10 bg-primary/20 flex items-center justify-center text-primary font-bold">
                                    ?
                                </div>
                                <div className="flex flex-col">
                                    <h1 className="text-gray-900 dark:text-white text-base font-medium leading-normal">Character</h1>
                                    <p className="text-gray-500 dark:text-[#bab09c] text-sm font-normal">Leveling Up</p>
                                </div>
                            </div>
                        </div>
                    </aside>

                    {/* Center Column: Main Content */}
                    <main className="flex flex-1 flex-col gap-6 h-full overflow-hidden">
                        <div className="flex flex-wrap justify-between gap-3 p-4 shrink-0">
                            <h1 className="text-gray-900 dark:text-white text-4xl font-black leading-tight tracking-[-0.033em] min-w-72">{title}</h1>
                            <div className="md:hidden flex items-center gap-2 bg-[#221c10] px-4 py-2 rounded-lg border border-[#544c3b]">
                                <span className="text-[#bab09c] text-sm">Points:</span>
                                <span className="text-primary font-bold">{points}</span>
                            </div>
                        </div>

                        <div className="flex flex-col p-4 gap-4 overflow-y-auto scrollbar-thin">
                            {Object.entries(skillPools).map(([category, categorySkills]) => (
                                <details key={category} className="flex flex-col rounded-xl border border-gray-200 dark:border-[#544c3b] bg-background-light dark:bg-[#221c10] px-4 group open:pb-2" open>
                                    <summary className="flex cursor-pointer items-center justify-between gap-6 py-4 list-none">
                                        <p className="text-gray-900 dark:text-white text-lg font-bold leading-normal">{category}</p>
                                        <span className="material-symbols-outlined text-gray-800 dark:text-white group-open:rotate-180 transition-transform">expand_more</span>
                                    </summary>
                                    <div className="flex flex-col divide-y divide-gray-200 dark:divide-[#544c3b]">
                                        {/* --- FIX: Use 'skill' object instead of just string --- */}
                                        {categorySkills.map((skill) => {
                                            const level = skills[skill.name] || 0;
                                            return (
                                                <div key={skill.name} className="flex gap-4 bg-background-light dark:bg-transparent px-0 py-4 justify-between items-center" onClick={() => setSelectedSkill(skill.name)}>
                                                    <div className="flex items-center gap-4">
                                                        <div className="text-gray-800 dark:text-white flex items-center justify-center rounded-lg bg-gray-200 dark:bg-[#393328] shrink-0 size-12">
                                                            <span className="material-symbols-outlined">{getCategoryIcon(category)}</span>
                                                        </div>
                                                        <div className="flex flex-col justify-center gap-1">
                                                            <p className={`text-base font-medium leading-normal cursor-pointer ${selectedSkill === skill.name ? 'text-primary' : 'text-gray-900 dark:text-white'}`}>
                                                                {skill.name}
                                                            </p>
                                                            <div className="w-24 bg-gray-200 dark:bg-[#393328] rounded-full h-1.5 hidden sm:block">
                                                                <div className="bg-primary h-1.5 rounded-full transition-all duration-300" style={{width: `${Math.min(100, level * 20)}%`}}></div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="shrink-0">
                                                        <div className="flex items-center gap-3 text-gray-800 dark:text-white">
                                                            <button 
                                                                onClick={(e) => { e.stopPropagation(); handleSkillChange(skill.name, -1); }} 
                                                                className="text-lg font-medium leading-normal flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 dark:bg-[#393328] cursor-pointer hover:bg-gray-300 dark:hover:bg-[#544c3b] disabled:opacity-30 disabled:cursor-not-allowed"
                                                                disabled={level <= 0}
                                                            >
                                                                -
                                                            </button>
                                                            <p className="text-base font-medium leading-normal w-8 text-center">{level}</p>
                                                            <button 
                                                                onClick={(e) => { e.stopPropagation(); handleSkillChange(skill.name, 1); }}
                                                                className="text-lg font-medium leading-normal flex h-8 w-8 items-center justify-center rounded-full bg-gray-200 dark:bg-[#393328] cursor-pointer hover:bg-gray-300 dark:hover:bg-[#544c3b] disabled:opacity-30 disabled:cursor-not-allowed"
                                                                disabled={points <= 0}
                                                            >
                                                                +
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </details>
                            ))}
                        </div>

                        {/* Action Buttons */}
                        <div className="flex justify-end gap-4 p-4 mt-auto shrink-0">
                            {onCancel && (
                                <button onClick={onCancel} className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-12 px-6 bg-gray-200 dark:bg-[#393328] text-gray-900 dark:text-white text-base font-bold leading-normal tracking-[0.015em] hover:bg-gray-300 dark:hover:bg-[#544c3b] transition-colors">
                                    Cancel
                                </button>
                            )}
                            <button 
                                onClick={() => onComplete(skills)} 
                                disabled={points < 0}
                                className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-12 px-6 bg-primary text-background-dark text-base font-bold leading-normal tracking-[0.015em] hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <span className="truncate">{completeButtonText}</span>
                            </button>
                        </div>
                    </main>

                    {/* Right Column: Info Panel Updates */}
                    <aside className="hidden lg:flex w-full max-w-[300px] flex-col">
                        <div className="sticky top-5 flex flex-col gap-4 rounded-xl border border-gray-200 dark:border-[#544c3b] p-6 bg-background-light dark:bg-[#221c10]">
                            {selectedSkill ? (
                                <>
                                    <div className="flex items-center gap-4">
                                        <div className="text-gray-800 dark:text-white flex items-center justify-center rounded-lg bg-gray-200 dark:bg-[#393328] shrink-0 size-12">
                                            <span className="material-symbols-outlined">info</span>
                                        </div>
                                        <div className="flex flex-col">
                                            <p className="text-gray-900 dark:text-white text-lg font-bold leading-normal">{selectedSkill}</p>
                                            <p className="text-gray-500 dark:text-[#bab09c] text-sm font-medium leading-normal">Skill Details</p>
                                        </div>
                                    </div>
                                    <div className="border-t border-gray-200 dark:border-[#544c3b] my-2"></div>
                                    <div className="flex flex-col gap-4">
                                        {/* --- FIX: Lookup Description from props --- */}
                                        <p className="text-gray-600 dark:text-[#bab09c] text-sm font-normal leading-relaxed">
                                            {Object.values(skillPools).flat().find(s => s.name === selectedSkill)?.description || "No description available."}
                                        </p>
                                        {/* ------------------------------------------ */}
                                        <div className="flex flex-col gap-2 rounded-lg bg-gray-100 dark:bg-[#393328]/50 p-4">
                                            <p className="text-gray-800 dark:text-white text-sm font-medium">Current Level: {skills[selectedSkill] || 0}</p>
                                            <p className="text-primary text-sm font-medium">Effect: Base {(skills[selectedSkill] || 0) * 10}% Bonus</p>
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <div className="text-center text-[#bab09c] py-10">
                                    <span className="material-symbols-outlined text-4xl mb-2 opacity-50">touch_app</span>
                                    <p>Select a skill to view details.</p>
                                </div>
                            )}
                        </div>
                    </aside>
                </div>
            </div>
        </div>
    );
};

// New Component for Multi-Save Character Selection
const CharacterSelect = ({
    saves,
    onSelect,
    onNew,
    onDelete,
    onLogout,
    onBack
}: {
    saves: SavedGame[],
    onSelect: (save: SavedGame) => void,
    onNew: () => void,
    onDelete: (id: string) => void,
    onLogout: () => void,
    onBack?: () => void
}) => {
    const [deleteId, setDeleteId] = useState<string | null>(null);

    const handleDeleteClick = (e: React.MouseEvent, id: string) => {
        e.stopPropagation(); // Prevent clicking the card itself
        setDeleteId(id);
    };

    const confirmDelete = () => {
        if (deleteId) {
            onDelete(deleteId);
            setDeleteId(null);
        }
    };

    return (
        <div className="relative flex min-h-screen w-full flex-col bg-background-dark font-display text-gray-100">
             {/* Background Image Layer */}
            <div className="fixed inset-0 z-0 bg-cover bg-center bg-no-repeat" style={{backgroundImage: 'url("https://images.unsplash.com/photo-1519074069444-1ba4fff66d16?q=80&w=2574&auto=format&fit=crop")'}}></div>
            <div className="fixed inset-0 z-0 bg-black/70 backdrop-blur-sm"></div>

            <div className="relative z-10 flex flex-col h-full p-4 sm:p-6 md:p-8 max-w-7xl mx-auto w-full">
                {/* Header */}
                <header className="flex flex-wrap items-center justify-between gap-4 p-4 mb-4">
                    <div className="flex flex-col gap-2">
                        <h1 className="text-4xl font-black leading-tight tracking-tighter text-white font-heading">Choose Your Hero</h1>
                        <p className="text-base font-normal leading-normal text-gray-300">Select an adventurer to continue your journey or forge a new legend.</p>
                    </div>
                    <div className="flex items-center gap-3">
                        {onBack && (
                            <button onClick={onBack} className="flex h-10 cursor-pointer items-center justify-center rounded-lg bg-[#393328]/80 backdrop-blur-sm border border-[#544c3b] px-4 text-sm font-bold text-white transition-all hover:bg-[#544c3b]">
                                Back
                            </button>
                        )}
                        <button onClick={onLogout} className="flex h-10 cursor-pointer items-center justify-center rounded-lg bg-transparent px-4 text-sm font-bold text-white/70 transition-colors hover:text-white hover:bg-white/5">
                            Sign Out
                        </button>
                    </div>
                </header>

                <main className="p-4">
                    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                        {/* Save Slots */}
                        {saves.map(save => (
                            <div key={save.id} onClick={() => onSelect(save)} className="group relative flex flex-col cursor-pointer overflow-hidden rounded-xl border border-white/10 bg-background-dark/80 backdrop-blur-sm transition-all duration-300 hover:border-primary/80 hover:shadow-2xl hover:shadow-primary/20 hover:-translate-y-1">
                                <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                                    <button
                                        onClick={(e) => handleDeleteClick(e, save.id)}
                                        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-red-800/80 text-white/80 transition-colors hover:bg-red-700 hover:text-white"
                                        title="Delete Character"
                                    >
                                        <span className="material-symbols-outlined text-base">delete</span>
                                    </button>
                                </div>
                                <div
                                    className="w-full bg-cover bg-center bg-no-repeat aspect-[3/4] transition-transform duration-500 group-hover:scale-105"
                                    style={{backgroundImage: `url("${save.gameState.character?.portrait || 'https://placehold.co/400x600/221c10/f2a60d?text=Unknown'}")`}}
                                >
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-80"></div>
                                </div>
                                <div className="absolute bottom-0 left-0 right-0 flex flex-col p-4">
                                    <p className="text-lg font-bold leading-normal text-white shadow-black drop-shadow-md font-display">{save.name}</p>
                                    <p className="text-sm font-normal leading-normal text-primary shadow-black drop-shadow-md">
                                        Lvl {Math.max(1, Object.values(save.gameState.character?.skills || {}).reduce((a, b) => a + b, 0) - 5)} {save.characterClass}
                                    </p>
                                    <button className="mt-3 flex w-full items-center justify-center rounded-lg h-9 bg-primary text-background-dark text-xs font-bold uppercase tracking-wide opacity-0 transform translate-y-2 transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
                                        Play
                                    </button>
                                </div>
                            </div>
                        ))}

                        {/* Create New Character Card */}
                        <div onClick={onNew} className="group flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-white/20 bg-white/5 p-4 text-center transition-all duration-300 hover:border-primary hover:bg-primary/10 cursor-pointer min-h-[300px]">
                            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/20 text-primary transition-transform duration-300 group-hover:scale-110 group-hover:rotate-90">
                                <span className="material-symbols-outlined text-4xl">add</span>
                            </div>
                            <div>
                                <p className="text-lg font-medium leading-normal text-white group-hover:text-primary transition-colors">Create New</p>
                                <p className="text-sm font-normal leading-normal text-gray-400">Forge a new legend</p>
                            </div>
                        </div>
                    </div>
                </main>
            </div>

            {/* Delete Confirmation Modal */}
            {deleteId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
                    <div className="w-full max-w-md rounded-xl border border-white/10 bg-[#221c10] p-6 shadow-2xl shadow-black/50">
                        <div className="flex flex-col gap-4 text-center">
                            <div className="flex justify-center">
                                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-900/30 text-red-500">
                                    <span className="material-symbols-outlined">warning</span>
                                </div>
                            </div>
                            <h3 className="text-xl font-bold text-white">Delete Character?</h3>
                            <p className="text-gray-300">
                                Are you sure you want to delete this hero? This action cannot be undone.
                            </p>
                            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                                <button onClick={() => setDeleteId(null)} className="flex flex-1 cursor-pointer items-center justify-center overflow-hidden rounded-lg h-10 px-4 bg-white/5 text-white text-sm font-bold leading-normal tracking-wide transition-colors hover:bg-white/10">Cancel</button>
                                <button onClick={confirmDelete} className="flex flex-1 cursor-pointer items-center justify-center overflow-hidden rounded-lg h-10 px-4 bg-red-800 text-white text-sm font-bold leading-normal tracking-wide transition-colors hover:bg-red-700">Delete</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const MapPanel = ({ mapState, onLocationClick, isLoading }: { mapState: MapState | null, onLocationClick: (locationName: string) => void, isLoading: boolean }) => {
    if (!mapState) {
        return <div className="map-panel"><Loader text="Loading map..." /></div>;
    }

    return (
        <div className="map-panel">
            {isLoading && <div className="illustration-loader"><Loader text="Traveling..." /></div>}
            <img src={mapState.backgroundImage || ''} alt="World Map" className="map-image" />
            {mapState.locations.map(location => (
                <button
                    key={location.name}
                    className={`map-location-btn ${location.visited ? 'visited' : ''}`}
                    style={{ left: `${location.x}%`, top: `${location.y}%` }}
                    onClick={() => onLocationClick(location.name)}
                    disabled={isLoading}
                    title={location.description}
                >
                    {location.name}
                </button>
            ))}
        </div>
    );
};

const LandingPage = ({ onPlayNow }: { onPlayNow: () => void }) => {
    return (
        // Updated bg-[#0A192F] instead of bg-landing-dark
        <div className="relative flex min-h-screen w-full flex-col bg-[#0A192F] font-sans text-slate-300 overflow-x-hidden">
            
            {/* Header (Fixed) */}
            <header className="fixed top-0 left-0 right-0 z-50 bg-[#0A192F]/90 backdrop-blur-md border-b border-white/5">
                <div className="container mx-auto px-6 py-4 flex justify-between items-center">
                    <div className="flex items-center gap-3 cursor-pointer" onClick={() => window.scrollTo({top: 0, behavior: 'smooth'})}>
                        {/* Updated text-[#FFBF00] */}
                        <span className="material-symbols-outlined text-[#FFBF00] text-3xl">fort</span>
                        <h1 className="font-serif text-xl font-bold text-white tracking-wider">Aethelgard's Echo</h1>
                    </div>
                    <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-300">
                        <a href="#features" className="hover:text-[#FFBF00] transition-colors">Features</a>
                        <a href="#how-to-play" className="hover:text-[#FFBF00] transition-colors">How to Play</a>
                        <a href="#lore" className="hover:text-[#FFBF00] transition-colors">Lore</a>
                    </nav>
                    {/* Updated Button Colors */}
                    <button onClick={onPlayNow} className="px-6 py-2 bg-[#FFBF00] text-[#0A192F] font-bold rounded-lg hover:bg-yellow-400 transition-all shadow-[0_0_15px_rgba(255,191,0,0.3)]">
                        Play Now
                    </button>
                </div>
            </header>

            <main>
                {/* Hero Section */}
                <section className="relative h-screen min-h-[800px] flex items-center justify-center overflow-hidden">
                    <div className="absolute inset-0 bg-cover bg-center" style={{backgroundImage: 'url("https://images.unsplash.com/photo-1519074069444-1ba4fff66d16?q=80&w=2574&auto=format&fit=crop")'}}></div>
                    <div className="absolute inset-0 bg-gradient-to-b from-[#0A192F]/80 via-[#0A192F]/60 to-[#0A192F]"></div>
                    
                    <div className="relative z-10 text-center px-4 max-w-4xl mx-auto flex flex-col items-center gap-8 mt-20">
                        <span className="px-4 py-1.5 rounded-full border border-[#FFBF00]/30 bg-[#FFBF00]/10 text-[#FFBF00] text-xs font-bold tracking-widest uppercase mb-4">
                            v1.0 Open Beta
                        </span>
                        <h1 className="font-serif text-6xl md:text-8xl font-black text-white leading-tight drop-shadow-2xl">
                            Aethelgard's <span className="text-[#FFBF00]">Echo</span>
                        </h1>
                        <p className="text-xl md:text-2xl text-slate-200 font-light leading-relaxed max-w-2xl">
                            An infinite text adventure where AI weaves the threads of destiny. No scripts. No limits. Just your imagination.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-4 mt-8">
                            {/* --- FIX IS HERE: Hardcoded Gold Background and Dark Text --- */}
                            <button 
                                onClick={onPlayNow} 
                                className="px-8 py-4 bg-[#FFBF00] text-[#0A192F] text-lg font-bold rounded-lg hover:bg-yellow-400 transition-all transform hover:scale-105 shadow-[0_0_20px_rgba(255,191,0,0.4)]"
                            >
                                Begin Your Journey
                            </button>
                            <a href="#features" className="px-8 py-4 bg-white/5 border border-white/10 text-white text-lg font-bold rounded-lg hover:bg-white/10 transition-all backdrop-blur-sm">
                                Explore Features
                            </a>
                        </div>
                    </div>
                    
                    <div className="absolute bottom-10 left-1/2 -translate-x-1/2 animate-bounce text-white/50">
                        <span className="material-symbols-outlined text-4xl">keyboard_arrow_down</span>
                    </div>
                </section>

                {/* Feature Grid */}
                <section id="features" className="py-24 px-6 bg-[#0A192F] relative">
                    <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"></div>
                    <div className="container mx-auto max-w-6xl">
                        <div className="text-center mb-20">
                            <h2 className="font-serif text-4xl font-bold text-white mb-4">Features That Await</h2>
                            <p className="text-slate-400 max-w-2xl mx-auto">Discover a game that listens, adapts, and grows with you.</p>
                        </div>
                        
                        <div className="grid md:grid-cols-3 gap-8">
                            {[
                                { icon: "psychology", title: "AI Storyteller", desc: "A live Dungeon Master that responds to your actions with dynamic, intelligent narration." },
                                { icon: "all_inclusive", title: "Limitless Choices", desc: "Go beyond multiple-choice. Type anything you want to do and watch the story unfold." },
                                { icon: "public", title: "Evolving World", desc: "The world remembers your actions. Burn a village? It stays burnt. Save a king? He remembers." },
                                { icon: "swords", title: "Dynamic Combat", desc: "Engage in visceral text-based combat where your skills and equipment matter." },
                                { icon: "group", title: "Multiplayer", desc: "Form a party with friends and adventure together in a shared, synchronized world." },
                                { icon: "auto_awesome", title: "Visual Imagination", desc: "Every scene is brought to life with AI-generated illustrations matching the narrative." }
                            ].map((f, i) => (
                                <div key={i} className="p-8 rounded-2xl bg-white/5 border border-white/10 hover:border-[#FFBF00]/50 transition-colors group">
                                    <div className="w-14 h-14 rounded-full bg-[#FFBF00]/10 flex items-center justify-center mb-6 group-hover:bg-[#FFBF00]/20 transition-colors">
                                        <span className="material-symbols-outlined text-3xl text-[#FFBF00]">{f.icon}</span>
                                    </div>
                                    <h3 className="font-serif text-xl font-bold text-white mb-3">{f.title}</h3>
                                    <p className="text-slate-400 leading-relaxed">{f.desc}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                {/* How to Play */}
                <section id="how-to-play" className="py-24 px-6 relative overflow-hidden">
                    <div className="absolute inset-0 bg-[#0d1f3a]"></div>
                    <div className="container mx-auto max-w-6xl relative z-10">
                        <div className="grid lg:grid-cols-2 gap-16 items-center">
                            <div>
                                <h2 className="font-serif text-4xl font-bold text-white mb-6">How It Works</h2>
                                <div className="space-y-8">
                                    {[
                                        { step: "01", title: "Create Your Hero", desc: "Choose your race, class, and background. Define your personality." },
                                        { step: "02", title: "Enter the World", desc: "You'll be dropped into a unique starting location generated just for you." },
                                        { step: "03", title: "Type Your Action", desc: "No buttons (unless you want them). Just type: 'I sneak past the guard' or 'I cast Fireball'." }
                                    ].map((s, i) => (
                                        <div key={i} className="flex gap-6">
                                            <div className="text-5xl font-serif font-black text-white/10">{s.step}</div>
                                            <div>
                                                <h3 className="text-xl font-bold text-white mb-2">{s.title}</h3>
                                                <p className="text-slate-400">{s.desc}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                <button onClick={onPlayNow} className="mt-10 px-8 py-3 bg-transparent border border-[#FFBF00] text-[#FFBF00] font-bold rounded-lg hover:bg-[#FFBF00] hover:text-[#0A192F] transition-all">
                                    Start Playing Now
                                </button>
                            </div>
                            <div className="relative">
                                <div className="absolute inset-0 bg-[#FFBF00]/20 blur-[100px] rounded-full"></div>
                                <div className="relative bg-[#0A192F] border border-white/10 rounded-xl p-6 shadow-2xl">
                                    <div className="flex items-center gap-2 mb-4 border-b border-white/10 pb-2">
                                        <div className="w-3 h-3 rounded-full bg-red-500"></div>
                                        <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                                        <div className="w-3 h-3 rounded-full bg-green-500"></div>
                                    </div>
                                    <div className="space-y-4 font-serif">
                                        <p className="text-slate-300"><span className="text-[#FFBF00] font-bold">DM:</span> You stand before the ancient obsidian gates. Runes glow faintly on the surface.</p>
                                        <p className="text-white/60 italic">&gt; I examine the runes closely to see if I recognize the language.</p>
                                        <p className="text-slate-300"><span className="text-[#FFBF00] font-bold">DM:</span> (Intelligence Check: Success) You recognize them as High Draconic. They speak of a "Key of Starlight" required to enter.</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Lore / Immersion Section */}
                <section id="lore" className="py-32 px-6 relative flex items-center justify-center text-center">
                    <div className="absolute inset-0 bg-cover bg-center" style={{backgroundImage: 'url("https://images.unsplash.com/photo-1605806616949-1e87b487bc2a?q=80&w=2574&auto=format&fit=crop")', backgroundAttachment: 'fixed'}}></div>
                    <div className="absolute inset-0 bg-[#0A192F]/80"></div>
                    
                    <div className="relative z-10 max-w-3xl mx-auto">
                        <span className="material-symbols-outlined text-6xl text-white/20 mb-6">auto_stories</span>
                        <h2 className="font-serif text-4xl md:text-5xl font-bold text-white mb-8">"In the Age of Silence, only Echoes remain..."</h2>
                        <p className="text-xl text-slate-300 leading-relaxed font-serif italic">
                            Aethelgard was once a beacon of magic, until the Veil shattered. Now, fragments of the old world drift in the void. You are a Wanderer, seeking the source of the Echo that calls to you from the abyss. Will you restore the light, or rule the darkness?
                        </p>
                    </div>
                </section>

                {/* Footer */}
                <footer className="bg-[#050e1c] py-12 px-6 border-t border-white/5">
                    <div className="container mx-auto max-w-6xl flex flex-col md:flex-row justify-between items-center gap-6">
                        <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-[#FFBF00]">fort</span>
                            <span className="font-serif font-bold text-white">Aethelgard's Echo</span>
                        </div>
                        <div className="text-slate-500 text-sm">
                            &copy; {new Date().getFullYear()} AI RPG Quest. Built with Gemini & React.
                        </div>
                        <div className="flex gap-6">
                            <a 
                                href="https://stefangisi.info" 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                className="text-slate-400 hover:text-white transition-colors" 
                                title="Check out my portfolio"
                            >
                                <span className="material-symbols-outlined">code</span>
                            </a>
                            <a 
                                href="https://teams.microsoft.com/l/chat/0/0?users=stefdgisi@gmail.com" 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                className="text-slate-400 hover:text-white transition-colors" 
                                title="Chat on Microsoft Teams"
                            >
                                <span className="material-symbols-outlined">chat</span>
                            </a>
                        </div>
                    </div>
                </footer>

            </main>
        </div>
    );
};

const MainMenuScreen = ({ onNewGame, onLoadGame, onMultiplayer, onExit }: { onNewGame: () => void, onLoadGame: () => void, onMultiplayer: () => void, onExit: () => void }) => {
    return (
        <div className="relative flex h-screen w-full flex-col bg-background-dark font-display overflow-hidden">
            <div className="flex h-full grow flex-col">
                <div className="px-4 flex flex-1 justify-center items-center">
                    <div className="flex flex-col w-full max-w-[960px] flex-1">
                        {/* --- FIX: Changed to the "Mystical/Fantasy" Library image --- */}
                        <div 
                            className="flex min-h-[480px] flex-col gap-6 bg-cover bg-center bg-no-repeat rounded-xl items-center justify-center p-4 relative overflow-hidden" 
                            style={{backgroundImage: 'url("https://images.unsplash.com/photo-1519074069444-1ba4fff66d16?q=80&w=2574&auto=format&fit=crop")'}}
                        >
                            {/* Gradient Overlay */}
                            <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-[#221c10]/90"></div>
                            
                            <div className="relative z-10 flex flex-col gap-2 text-center">
                                <h1 className="text-white text-5xl font-black leading-tight tracking-tight font-serif drop-shadow-lg">Aethelgard's Echo</h1>
                                <h2 className="text-white/90 text-lg font-medium drop-shadow-md">An AI-Powered Text Adventure</h2>
                            </div>
                            
                            <div className="relative z-10 flex flex-col gap-3 w-full max-w-md mt-8">
                                <button onClick={onNewGame} className="flex items-center justify-center rounded-lg h-14 px-5 bg-primary text-background-dark text-lg font-bold hover:brightness-110 transition-all shadow-lg hover:scale-105">
                                    New Game
                                </button>
                                <button onClick={onLoadGame} className="flex items-center justify-center rounded-lg h-14 px-5 bg-[#393328]/90 backdrop-blur-sm border border-[#544c3b] text-white text-lg font-bold hover:bg-[#544c3b] transition-all shadow-md">
                                    Load Game
                                </button>
                                <button onClick={onMultiplayer} className="flex items-center justify-center rounded-lg h-14 px-5 bg-[#393328]/90 backdrop-blur-sm border border-[#544c3b] text-white text-lg font-bold hover:bg-[#544c3b] transition-all shadow-md">
                                    Multiplayer
                                </button>
                                <button onClick={onExit} className="flex items-center justify-center rounded-lg h-12 px-5 bg-transparent text-white/70 text-sm font-bold hover:text-white mt-4 hover:bg-white/5 transition-colors">
                                    Sign Out
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const SettingsModal = ({ isOpen, onClose, currentAccent, onChangeAccent }: { isOpen: boolean, onClose: () => void, currentAccent: 'US' | 'GB', onChangeAccent: (a: 'US' | 'GB') => void }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="w-full max-w-sm rounded-xl border border-[#544c3b] bg-[#181611] p-6 shadow-2xl shadow-black/50" onClick={e => e.stopPropagation()}>
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-xl font-bold text-white font-display">Settings</h3>
                    <button onClick={onClose} className="text-[#bab09c] hover:text-white"><span className="material-symbols-outlined">close</span></button>
                </div>
                
                <div className="space-y-4">
                    <div>
                        <label className="block text-[#bab09c] text-sm font-medium mb-3">Narrator Voice</label>
                        <div className="grid grid-cols-2 gap-3">
                            <button 
                                onClick={() => onChangeAccent('US')} 
                                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-all ${currentAccent === 'US' ? 'bg-primary text-background-dark border-primary font-bold' : 'bg-transparent text-[#bab09c] border-[#393328] hover:border-[#544c3b]'}`}
                            >
                                🇺🇸 US
                            </button>
                            <button 
                                onClick={() => onChangeAccent('GB')} 
                                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-all ${currentAccent === 'GB' ? 'bg-primary text-background-dark border-primary font-bold' : 'bg-transparent text-[#bab09c] border-[#393328] hover:border-[#544c3b]'}`}
                            >
                                🇬🇧 GB
                            </button>
                        </div>
                    </div>
                </div>

                <button onClick={onClose} className="mt-8 w-full py-3 bg-[#221c10] border border-[#393328] text-[#bab09c] font-bold rounded-lg hover:bg-[#2a2418] transition-colors">
                    Close
                </button>
            </div>
        </div>
    );
};

const GameScreen = ({ gameState, onAction, onBackToMenu, onLevelUp, isLoading, getAlignmentDescriptor, onOpenGambling, isMyTurn }: any) => {
    const { character, storyLog, currentActions, map, companions } = gameState;
    const [customInput, setCustomInput] = useState("");''
    
    // --- NEW STATE FOR SETTINGS ---
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [voiceAccent, setVoiceAccent] = useState<'US' | 'GB'>('US');

    const [viewingSkill, setViewingSkill] = useState<Skill | null>(null);

    const storyEndRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        storyEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [storyLog]);

    // --- UPDATED AUDIO HANDLER ---
    const handlePlayAudio = (text: string) => {
        if (speechSynthesis.speaking) { 
            speechSynthesis.cancel(); 
            return; 
        }
        const utterance = new SpeechSynthesisUtterance(text);
        
        // Voice selection logic
        const voices = speechSynthesis.getVoices();
        const targetLang = voiceAccent === 'US' ? 'en-US' : 'en-GB';
        
        // Try to find a voice that matches the accent AND the character's gender if possible, otherwise fallback to just accent
        const genderKeyword = character.gender === 'Female' ? 'Female' : 'Male';
        let selectedVoice = voices.find(v => v.lang === targetLang && v.name.includes(genderKeyword));
        
        if (!selectedVoice) {
            selectedVoice = voices.find(v => v.lang === targetLang);
        }
        
        if (selectedVoice) utterance.voice = selectedVoice;
        
        speechSynthesis.speak(utterance);
    };

    const handleCustomSubmit = (e: FormEvent) => {
        e.preventDefault();
        if (customInput.trim() && !isLoading && isMyTurn) {
            onAction(customInput);
            setCustomInput("");
        }
    };

    // --- ADD: Helper to find skill description ---
    const handleSkillClick = (skillName: string) => {
        // Search in skillPools (if available) or default to generic
        let foundSkill: Skill | undefined;
        if (gameState.skillPools) {
            foundSkill = Object.values(gameState.skillPools).flat().find(s => s.name === skillName);
        }
        
        if (foundSkill) {
            setViewingSkill(foundSkill);
        } else {
            // Fallback if description isn't found
            setViewingSkill({ name: skillName, description: "An ability learned during your adventures. (Description unavailable)" });
        }
    };

    return (
        <div className="relative flex h-screen w-full flex-col overflow-hidden bg-background-dark font-display">
            <div className="flex h-full flex-1 overflow-hidden">
                
                {/* Left Sidebar: Character Sheet */}
                <aside className="hidden md:flex w-[320px] flex-col border-r border-[#393328] bg-[#181611] p-6 overflow-y-auto scrollbar-thin">
                    <div className="flex items-center gap-4 mb-6">
                        <div className="bg-center bg-no-repeat bg-cover rounded-full size-16 border-2 border-[#544c3b]" style={{backgroundImage: `url(${character.portrait})`}}></div>
                        <div>
                            <h1 className="text-white text-xl font-bold font-display">{character.name}</h1>
                            <p className="text-[#bab09c] text-sm">Lvl {Math.max(1, Object.values(character.skills).reduce((a:any,b:any)=>a+b,0)-5)} Adventurer</p>
                        </div>
                    </div>

                    <div className="space-y-4 mb-6">
                        <div>
                            <div className="flex justify-between text-sm mb-1"><span className="text-white font-medium">Health</span><span className="text-[#bab09c]">{character.hp} / {character.maxHp}</span></div>
                            <div className="w-full rounded bg-[#2a2a2a] h-2 overflow-hidden"><div className="h-full bg-red-600" style={{width: `${(character.hp/character.maxHp)*100}%`}}></div></div>
                        </div>
                        <div>
                            <div className="flex justify-between text-sm mb-1"><span className="text-white font-medium">Experience</span><span className="text-[#bab09c]">{character.xp}</span></div>
                            <div className="w-full rounded bg-[#2a2a2a] h-2 overflow-hidden"><div className="h-full bg-blue-600" style={{width: `${Math.min(100, (character.xp % 100))}%`}}></div></div>
                        </div>
                    </div>

                    <div className="space-y-2 mb-6 border-t border-b border-[#393328] py-4">
                        {/* New Stats Grid */}
                        <div className="grid grid-cols-3 gap-2 text-center mb-4">
                            <div className="bg-white/5 rounded p-1">
                                <div className="text-[#bab09c] text-[10px] uppercase">STR</div>
                                <div className="text-white font-bold">{character.stats.str}</div>
                            </div>
                            <div className="bg-white/5 rounded p-1">
                                <div className="text-[#bab09c] text-[10px] uppercase">DEX</div>
                                <div className="text-white font-bold">{character.stats.dex}</div>
                            </div>
                            <div className="bg-white/5 rounded p-1">
                                <div className="text-[#bab09c] text-[10px] uppercase">CON</div>
                                <div className="text-white font-bold">{character.stats.con}</div>
                            </div>
                            <div className="bg-white/5 rounded p-1">
                                <div className="text-[#bab09c] text-[10px] uppercase">WIS</div>
                                <div className="text-white font-bold">{character.stats.wis}</div>
                            </div>
                            <div className="bg-white/5 rounded p-1">
                                <div className="text-[#bab09c] text-[10px] uppercase">CHA</div>
                                <div className="text-white font-bold">{character.stats.cha}</div>
                            </div>
                            <div className="bg-white/5 rounded p-1">
                                <div className="text-[#bab09c] text-[10px] uppercase">INT</div>
                                <div className="text-white font-bold">{character.stats.int}</div>
                            </div>
                        </div>
                        <div className="flex justify-between"><span className="text-[#bab09c] text-sm">Gold</span><span className="text-primary text-sm font-bold">{character.gold} GP</span></div>
                        <div className="flex justify-between"><span className="text-[#bab09c] text-sm">Alignment</span><span className="text-white text-sm">{getAlignmentDescriptor(character.alignment)}</span></div>
                        {character.skillPoints > 0 && (
                            <button onClick={onLevelUp} className="w-full mt-2 py-2 bg-primary text-background-dark font-bold rounded text-sm animate-pulse">Level Up Available!</button>
                        )}
                    </div>

                    <div className="space-y-3">
                        {/* Skills */}
                        <details className="group rounded-lg border border-[#393328] bg-[#221c10] open:bg-[#2a2418] transition-colors">
                            <summary className="flex cursor-pointer items-center justify-between p-3 font-medium text-white list-none">
                                <span>Skills</span><span className="material-symbols-outlined transition-transform group-open:rotate-180">expand_more</span>
                            </summary>
                            <div className="px-3 pb-3 text-sm text-[#bab09c] space-y-1">
                                {/* --- FIX: Make skills clickable --- */}
                                {Object.entries(character.skills).map(([s, l]: any) => (
                                    <div 
                                        key={s} 
                                        className="flex justify-between hover:bg-white/5 p-1 rounded cursor-pointer transition-colors"
                                        onClick={() => handleSkillClick(s)}
                                    >
                                        <span>{s}</span><span className="text-white">Lvl {l}</span>
                                    </div>
                                ))}
                            </div>
                        </details>

                        {/* Equipment */}
                        <details className="group rounded-lg border border-[#393328] bg-[#221c10] open:bg-[#2a2418] transition-colors" open>
                            <summary className="flex cursor-pointer items-center justify-between p-3 font-medium text-white list-none">
                                <span>Equipment</span><span className="material-symbols-outlined transition-transform group-open:rotate-180">expand_more</span>
                            </summary>
                            <div className="px-3 pb-3 text-sm text-[#bab09c] space-y-2">
                                <div className="flex flex-col gap-1 pb-1 border-b border-white/5">
                                    <div className="flex justify-between text-white"><span>⚔️ {character.equipment.weapon?.name || "Unarmed"}</span></div>
                                    {character.equipment.weapon?.stats.damage && (
                                        <div className="text-xs text-primary flex justify-end">DMG: {character.equipment.weapon.stats.damage}</div>
                                    )}
                                </div>
                                <div className="flex flex-col gap-1 pb-1 border-b border-white/5">
                                    <div className="flex justify-between text-white"><span>🛡️ {character.equipment.armor?.name || "No Armor"}</span></div>
                                    {character.equipment.armor?.stats.damageReduction && (
                                        <div className="text-xs text-blue-400 flex justify-end">DR: {character.equipment.armor.stats.damageReduction}</div>
                                    )}
                                </div>
                                {character.equipment.gear?.map((g:any, i:number) => (
                                    <div key={i} className="flex justify-between text-xs opacity-80">
                                        <span>• {g.name}</span>
                                        {(g.stats.damage || g.stats.damageReduction) && 
                                            <span className="text-white/50">
                                                {g.stats.damage ? `+${g.stats.damage} D` : ''} 
                                                {g.stats.damageReduction ? ` +${g.stats.damageReduction} DR` : ''}
                                            </span>
                                        }
                                    </div>
                                ))}
                            </div>
                        </details>

                        {/* Party / Companions */}
                        <details className="group rounded-lg border border-[#393328] bg-[#221c10] open:bg-[#2a2418] transition-colors">
                            <summary className="flex cursor-pointer items-center justify-between p-3 font-medium text-white list-none">
                                <span>Allies</span><span className="material-symbols-outlined transition-transform group-open:rotate-180">expand_more</span>
                            </summary>
                            <div className="px-3 pb-3 text-sm text-[#bab09c] space-y-2">
                                {companions && companions.length > 0 ? (
                                    companions.map((comp: any, i: number) => (
                                        <div key={i} className="flex justify-between items-center bg-black/20 p-2 rounded">
                                            <span className="text-white">{comp.name}</span>
                                            <span className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${comp.relationship >= 50 ? 'bg-green-900/40 text-green-400' : comp.relationship <= -50 ? 'bg-red-900/40 text-red-400' : 'bg-white/10 text-white/50'}`}>
                                                {comp.relationship >= 50 ? 'Friend' : comp.relationship <= -50 ? 'Rival' : 'Neutral'}
                                            </span>
                                        </div>
                                    ))
                                ) : (
                                    <div className="text-center italic opacity-50 py-2">No allies yet.</div>
                                )}
                            </div>
                        </details>
                    </div>
                    
                    <div className="mt-auto pt-4">
                        <button onClick={onBackToMenu} className="flex items-center justify-center gap-2 w-full py-3 text-[#bab09c] hover:text-white transition-colors">
                            <span className="material-symbols-outlined">logout</span> Return to Menu
                        </button>
                    </div>
                </aside>

                {/* Center: Story & Actions */}
                <main className="flex flex-1 flex-col h-full relative">
                    <div className="md:hidden h-14 border-b border-[#393328] flex items-center justify-center relative px-4 bg-[#181611]">
                        <span className="font-bold text-white">{character.name}</span>
                        <button onClick={onBackToMenu} className="absolute left-4 text-[#bab09c]"><span className="material-symbols-outlined">arrow_back</span></button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-6 md:p-12 scrollbar-thin bg-background-dark">
                        <div className="max-w-3xl mx-auto space-y-8 pb-8">
                            {storyLog.map((segment: any, i: number) => (
                                <div key={i} className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
                                    {segment.illustration && (
                                        <div className="rounded-xl overflow-hidden border border-[#393328] shadow-lg">
                                            <img src={segment.illustration} className="w-full h-auto object-cover max-h-[400px]" alt="Scene" />
                                        </div>
                                    )}
                                    
                                    {/* --- RESTORED READ ALOUD BUTTON --- */}
                                    <div className="relative group">
                                        <p className="font-serif text-lg md:text-xl leading-relaxed text-[#e0e0e0] whitespace-pre-line pr-8">
                                            {segment.text}
                                        </p>
                                        <button 
                                            onClick={() => handlePlayAudio(segment.text)}
                                            className="absolute -right-2 top-0 p-2 text-[#bab09c]/30 hover:text-primary transition-colors rounded-full hover:bg-white/5"
                                            title="Read Aloud"
                                        >
                                            <span className="material-symbols-outlined text-xl">volume_up</span>
                                        </button>
                                    </div>
                                    {/* ---------------------------------- */}

                                    {segment.skillCheck && (
                                        <div className={`p-3 rounded border text-sm font-bold ${segment.skillCheck.success ? 'border-green-900 bg-green-900/20 text-green-400' : 'border-red-900 bg-red-900/20 text-red-400'}`}>
                                            Dice Roll: {segment.skillCheck.skillName} check {segment.skillCheck.success ? 'SUCCEEDED' : 'FAILED'}
                                        </div>
                                    )}
                                </div>
                            ))}
                            {isLoading && <div className="flex justify-center py-4"><div className="loader border-primary/30 border-t-primary h-8 w-8"></div></div>}
                            <div ref={storyEndRef} />
                        </div>
                    </div>

                    <div className="border-t border-[#393328] bg-[#181611] p-4 md:p-6 z-20">
                        <div className="max-w-3xl mx-auto">
                            <p className="font-serif text-lg italic text-primary/80 mb-4 text-center">What do you do?</p>
                            
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                                {currentActions.map((action: string, i: number) => (
                                    <button 
                                        key={i} 
                                        onClick={() => onAction(action)}
                                        disabled={isLoading || !isMyTurn}
                                        className="text-left rounded-lg border border-[#544c3b] bg-[#221c10] px-4 py-3 text-white transition-all hover:bg-primary hover:text-background-dark hover:border-primary disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {i + 1}. {action}
                                    </button>
                                ))}
                            </div>

                            <form onSubmit={handleCustomSubmit} className="relative">
                                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#bab09c]">keyboard</span>
                                <input 
                                    type="text" 
                                    value={customInput}
                                    onChange={(e) => setCustomInput(e.target.value)}
                                    disabled={isLoading || !isMyTurn}
                                    className="w-full rounded-lg border border-[#544c3b] bg-[#221c10] py-3 pl-10 pr-4 text-white placeholder:text-[#bab09c]/50 focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-colors"
                                    placeholder={isMyTurn ? "Or type your own command..." : "Waiting for other players..."}
                                />
                            </form>
                        </div>
                    </div>
                </main>

                {/* Right Sidebar: Map */}
                <aside className="hidden lg:flex w-[320px] flex-col border-l border-[#393328] bg-[#181611] p-6">
                    <div className="flex items-center gap-3 mb-4">
                        <span className="material-symbols-outlined text-2xl text-white">map</span>
                        <h3 className="text-lg font-bold text-white">World Map</h3>
                    </div>
                    <div className="relative flex-1 rounded-lg overflow-hidden border border-[#393328] bg-black">
                        {map && map.backgroundImage ? (
                            <>
                                <div className="absolute inset-0 bg-center bg-cover opacity-50" style={{backgroundImage: `url(${map.backgroundImage})`}}></div>
                                {map.locations.map((loc: any) => (
                                    <div 
                                        key={loc.name}
                                        className="absolute transform -translate-x-1/2 -translate-y-1/2 cursor-pointer group"
                                        style={{left: `${loc.x}%`, top: `${loc.y}%`}}
                                        onClick={() => onAction(`Travel to ${loc.name}`)}
                                    >
                                        <span className={`material-symbols-outlined text-2xl drop-shadow-md ${loc.visited ? 'text-primary' : 'text-white/50'}`}>
                                            {loc.visited ? 'location_on' : 'radio_button_unchecked'}
                                        </span>
                                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-black/90 text-white text-xs px-2 py-1 rounded whitespace-nowrap z-10 border border-[#544c3b]">
                                            {loc.name}
                                        </div>
                                    </div>
                                ))}
                            </>
                        ) : (
                            <div className="flex items-center justify-center h-full text-[#bab09c] text-sm italic">Map unavailable</div>
                        )}
                    </div>
                    <div className="mt-6 flex justify-center gap-4">
                        <button onClick={onOpenGambling} className="flex flex-col items-center text-[#bab09c] hover:text-primary transition-colors">
                            <span className="material-symbols-outlined mb-1">casino</span>
                            <span className="text-xs">Gambling</span>
                        </button>
                        
                        {/* --- MODIFIED SETTINGS BUTTON --- */}
                        <button onClick={() => setIsSettingsOpen(true)} className="flex flex-col items-center text-[#bab09c] hover:text-primary transition-colors">
                            <span className="material-symbols-outlined mb-1">settings</span>
                            <span className="text-xs">Settings</span>
                        </button>
                    </div>
                </aside>
            </div>

            <SettingsModal 
                isOpen={isSettingsOpen} 
                onClose={() => setIsSettingsOpen(false)} 
                currentAccent={voiceAccent}
                onChangeAccent={setVoiceAccent}
            />
            <SkillDetailModal 
                skill={viewingSkill} 
                onClose={() => setViewingSkill(null)} 
            />
        </div>
    );
};

const CombatScreen = ({ gameState, onCombatAction, isLoading, onBackToMenu }: { gameState: GameState, onCombatAction: (action: string) => void, isLoading: boolean, onBackToMenu: () => void }) => {
    if (!gameState.character || !gameState.combat) return <Loader text="Loading combat..." />;
    const { character, combat } = gameState;

    // Auto-scroll combat log
    const logEndRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [combat.log]);

    // Helper to get icon for action button
    const getActionIcon = (action: string) => {
        const lower = action.toLowerCase();
        if (lower.includes('attack') || lower.includes('strike')) return 'swords';
        if (lower.includes('magic') || lower.includes('spell') || lower.includes('cast')) return 'auto_fix_high';
        if (lower.includes('defend') || lower.includes('block') || lower.includes('shield')) return 'shield';
        if (lower.includes('heal') || lower.includes('potion') || lower.includes('item')) return 'health_and_safety';
        return 'flash_on'; // Default
    };

    const level = Math.max(1, Object.values(character.skills).reduce((a:any,b:any)=>a+b,0)-5);

    return (
        <div className="relative flex h-screen w-full flex-col bg-background-dark font-landing-body text-gray-300 overflow-hidden">
            
            {/* Header */}
            <header className="flex items-center justify-between whitespace-nowrap border-b border-border-dark px-6 py-3 bg-surface-dark font-combat-display shrink-0 z-10">
                <div className="flex items-center gap-4 text-white">
                    <div className="size-6">
                        <span className="material-symbols-outlined text-combat-primary text-3xl">swords</span>
                    </div>
                    <h2 className="text-white text-xl font-bold tracking-wide">Combat Encounter</h2>
                </div>
                <div className="text-gray-400 text-lg hidden md:block">
                    The Whispering Crypts
                </div>
                <div className="flex gap-2">
                    <button onClick={onBackToMenu} className="flex items-center justify-center rounded-lg h-10 px-3 bg-surface-dark text-white/80 hover:bg-border-dark hover:text-combat-primary transition-colors border border-border-dark" title="Retreat / Menu">
                        <span className="material-symbols-outlined">logout</span>
                    </button>
                </div>
            </header>

            {/* Main Layout: Left Sidebar + Right Content Area */}
            <div className="flex flex-1 overflow-hidden">
                
                {/* Left Column: Player Status (Full Height Sidebar) */}
                <aside className="w-80 hidden md:flex flex-col gap-6 bg-surface-dark border-r border-border-dark p-6 overflow-y-auto shrink-0 scrollbar-thin">
                    
                    {/* Portrait & Info */}
                    <div className="flex flex-col items-center text-center">
                        <div 
                            className="w-32 h-32 bg-center bg-no-repeat aspect-square bg-cover rounded-full mb-4 border-4 border-border-dark shadow-lg" 
                            style={{backgroundImage: `url(${character.portrait})`}}
                        ></div>
                        <p className="text-white text-2xl font-bold leading-tight tracking-wide font-combat-display">{character.name}</p>
                        <p className="text-combat-primary text-sm font-bold uppercase tracking-wider mb-2">Lvl {level} Adventurer</p>
                    </div>
                    
                    {/* Stats Bars */}
                    <div className="flex flex-col gap-4 w-full">
                        <div className="flex flex-col gap-1.5">
                            <div className="flex gap-6 justify-between items-center">
                                <p className="text-gray-300 text-sm font-bold leading-normal uppercase tracking-wider">Health</p>
                                <span className="font-mono text-sm text-gray-400">{character.hp} / {character.maxHp}</span>
                            </div>
                            <div className="rounded-full bg-border-dark h-3 w-full overflow-hidden">
                                <div className="h-full rounded-full bg-player-heal transition-all duration-500" style={{width: `${Math.max(0, Math.min(100, (character.hp/character.maxHp)*100))}%`}}></div>
                            </div>
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <div className="flex gap-6 justify-between items-center">
                                <p className="text-gray-300 text-sm font-bold leading-normal uppercase tracking-wider">XP</p>
                                <span className="font-mono text-sm text-gray-400">{character.xp}</span>
                            </div>
                            <div className="rounded-full bg-border-dark h-3 w-full overflow-hidden">
                                <div className="h-full rounded-full bg-blue-500 transition-all duration-500" style={{width: `${Math.min(100, (character.xp % 100))}%`}}></div>
                            </div>
                        </div>
                    </div>

                    {/* Equipment & Stats */}
                    <div className="mt-auto pt-4 border-t border-border-dark w-full">
                        <p className="text-gray-300 text-sm font-bold leading-normal uppercase tracking-wider mb-3">Equipment</p>
                        <div className="space-y-3 text-sm text-gray-400">
                            <div className="flex flex-col gap-1 bg-black/20 p-2 rounded border border-white/5">
                                <div className="flex items-center gap-2 text-white"><span className="material-symbols-outlined text-combat-primary text-sm">swords</span> Weapon</div>
                                <div className="flex justify-between items-center">
                                    <span>{character.equipment.weapon?.name || "Unarmed"}</span>
                                    {character.equipment.weapon?.stats.damage && <span className="text-xs text-combat-primary">DMG: {character.equipment.weapon.stats.damage}</span>}
                                </div>
                            </div>
                            <div className="flex flex-col gap-1 bg-black/20 p-2 rounded border border-white/5">
                                <div className="flex items-center gap-2 text-white"><span className="material-symbols-outlined text-blue-400 text-sm">shield</span> Armor</div>
                                <div className="flex justify-between items-center">
                                    <span>{character.equipment.armor?.name || "No Armor"}</span>
                                    {character.equipment.armor?.stats.damageReduction && <span className="text-xs text-blue-400">DR: {character.equipment.armor.stats.damageReduction}</span>}
                                </div>
                            </div>
                        </div>
                    </div>
                </aside>

                {/* Right Area: Log, Enemies, Actions */}
                <main className="flex flex-1 flex-col min-w-0 bg-background-dark">
                    
                    {/* Top Section: Log & Enemies */}
                    <div className="flex-1 flex flex-row overflow-hidden p-4 md:p-6 gap-4 md:gap-6">
                        
                        {/* Center: Combat Log */}
                        <section className="flex-1 flex flex-col bg-surface-dark border border-border-dark rounded-lg overflow-hidden shadow-2xl">
                            <div className="p-4 border-b border-border-dark bg-[#151518] flex justify-between items-center">
                                <h3 className="text-white text-xl font-bold font-combat-display tracking-wide">Combat Log</h3>
                                {/* Mobile-only HP indicator could go here */}
                            </div>
                            <div className="flex-1 p-4 md:p-6 overflow-y-auto space-y-3 bg-[#0e0e10] scrollbar-thin">
                                {combat.log.map((entry, i) => (
                                    <div key={i} className="animate-in fade-in slide-in-from-bottom-1 duration-300 border-b border-white/5 pb-2 last:border-0">
                                        <span className="text-gray-600 font-mono text-[10px] mr-3 block sm:inline">[{new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}]</span>
                                        <span className={`text-sm md:text-base ${entry.type === 'player' ? 'text-combat-primary' : entry.type === 'enemy' ? 'text-enemy-damage' : 'text-gray-300 italic'}`}>
                                            {entry.message}
                                        </span>
                                    </div>
                                ))}
                                <div ref={logEndRef} />
                            </div>
                        </section>

                        {/* Right: Enemies List */}
                        <aside className="w-72 flex flex-col gap-4 overflow-y-auto hidden lg:flex shrink-0 scrollbar-thin">
                            {combat.enemies.map((enemy) => (
                                <div key={enemy.id} className={`flex flex-col items-stretch justify-start rounded-lg bg-surface-dark border border-border-dark p-4 transition-all duration-500 ${enemy.hp <= 0 ? 'opacity-50 grayscale' : 'ring-1 ring-white/5 hover:ring-combat-primary/30'}`}>
                                    <div className="flex flex-col gap-3">
                                        <div className="flex items-center gap-3">
                                             <div 
                                                className="w-12 h-12 bg-center bg-no-repeat bg-cover rounded-lg flex-shrink-0 border border-border-dark" 
                                                style={{backgroundImage: `url(${enemy.portrait || 'https://placehold.co/100x100/2D3142/FFF?text=Enemy'})`}}
                                            ></div>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-white text-base font-bold leading-tight font-combat-display truncate" title={enemy.name}>{enemy.name}</p>
                                            </div>
                                        </div>
                                        
                                        <div className="flex flex-col gap-1">
                                            <div className="flex gap-4 justify-between items-center">
                                                <p className="text-gray-400 text-[10px] uppercase tracking-wider">Health</p>
                                                <span className="font-mono text-xs text-gray-400">{Math.max(0, enemy.hp)} / {enemy.maxHp}</span>
                                            </div>
                                            <div className="rounded-full bg-border-dark h-1.5 w-full overflow-hidden">
                                                <div className="h-full rounded-full bg-enemy-damage transition-all duration-500" style={{width: `${Math.max(0, (enemy.hp / enemy.maxHp) * 100)}%`}}></div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </aside>
                    </div>

                    {/* Bottom Section: Actions */}
                    <footer className="p-6 bg-background-dark border-t border-border-dark shrink-0">
                        <div className="bg-surface-dark border border-border-dark rounded-lg p-4 flex justify-center items-start gap-4 md:gap-8 flex-wrap">
                            {combat.availableActions.map((action) => (
                                <button 
                                    key={action}
                                    onClick={() => onCombatAction(action)}
                                    disabled={isLoading}
                                    // --- FIX: Doubled width classes (w-48 md:w-56) ---
                                    className="group flex flex-col items-center gap-2 w-48 md:w-56 text-center text-white/70 hover:text-combat-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <div className="rounded-lg bg-border-dark group-hover:bg-combat-primary/20 p-3 transition-all transform group-hover:-translate-y-1 border border-transparent group-hover:border-combat-primary/50 w-full flex justify-center">
                                        <span className="material-symbols-outlined text-3xl md:text-4xl">{getActionIcon(action)}</span>
                                    </div>
                                    <p className="text-xs md:text-sm font-bold uppercase tracking-wider w-full break-words leading-tight">{action}</p>
                                </button>
                            ))}
                        </div>
                    </footer>

                </main>
            </div>
        </div>
    );
};

const LootScreen = ({ loot, onContinue }: { loot: Loot, onContinue: () => void }) => {
    return (
        <div className="relative flex min-h-screen w-full flex-col items-center justify-center p-4 sm:p-6 lg:p-8 bg-background-dark font-display">
            <div className="w-full max-w-2xl rounded-xl border border-primary/20 bg-background-dark/50 p-6 sm:p-8 text-center shadow-lg shadow-primary/10 backdrop-blur-sm">
                <div className="layout-content-container flex flex-col gap-6 sm:gap-8">
                    {/* Header */}
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-5xl font-heading text-primary drop-shadow-md">VICTORY!</h1>
                        <p className="mt-2 text-base leading-normal text-gray-400 sm:text-lg">The enemy has been vanquished!</p>
                    </div>

                    {/* Rewards Section */}
                    <div className="flex flex-col gap-4">
                        <h4 className="text-sm font-bold uppercase tracking-widest text-gray-500">Spoils of Victory</h4>
                        
                        {/* Stats Cards */}
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="flex flex-col gap-2 rounded-lg border border-[#393328] bg-[#181611] p-6">
                                <p className="text-base font-medium text-gray-300">XP Gained</p>
                                <p className="text-3xl font-bold tracking-tight text-white">+???</p> {/* You can pass xpGained if you track it in state, otherwise placeholder */}
                            </div>
                            <div className="flex flex-col gap-2 rounded-lg border border-[#393328] bg-[#181611] p-6">
                                <p className="text-base font-medium text-gray-300">Gold Acquired</p>
                                <p className="text-3xl font-bold tracking-tight text-primary">+{loot.gold}</p>
                            </div>
                        </div>

                        {/* Item Grid */}
                        {loot.items.length > 0 && (
                            <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-4 pt-2">
                                {loot.items.map((item, index) => (
                                    <div key={index} className="flex flex-col gap-3 p-3 rounded-lg border border-[#393328] bg-[#181611] hover:border-primary/50 transition-colors">
                                        <div className="w-full aspect-square rounded-lg bg-[#221c10] flex items-center justify-center text-gray-500">
                                            {/* Placeholder Icon since we don't have item images yet */}
                                            <span className="material-symbols-outlined text-4xl">backpack</span>
                                        </div>
                                        <div className="text-left">
                                            <p className="text-sm font-medium leading-normal text-white truncate" title={item.name}>{item.name}</p>
                                            <p className="text-xs leading-normal text-gray-500">{item.value}g</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        {loot.items.length === 0 && (
                            <p className="text-gray-500 italic">No items found.</p>
                        )}
                    </div>

                    {/* CTA */}
                    <div className="flex flex-col gap-4 pt-4 sm:pt-6">
                        <button 
                            onClick={onContinue}
                            className="w-full rounded-lg bg-primary px-8 py-3 text-base font-bold text-background-dark transition-transform hover:scale-105 active:scale-100 shadow-lg shadow-primary/20"
                        >
                            Continue Adventure
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const TransactionScreen = ({ gameState, onTransaction, onExit }: { gameState: GameState, onTransaction: (item: Equipment, action: 'buy' | 'sell') => void, onExit: () => void }) => {
    if (!gameState.character || !gameState.transaction) return <Loader text="Loading transaction..." />;
    const { character, transaction } = gameState;

    // Calculate Price Modifiers based on CHA
    const cha = character.stats.cha;
    // "lowers prices when buying" -> High CHA = Low Multiplier
    // Base 8. For every point above 8, reduce price by 2%. Max 50% off.
    const buyMult = Math.max(0.5, 1.0 - ((cha - 8) * 0.02));
    
    // "increases prices when selling" -> High CHA = High Multiplier
    // Base sell is 50% of value. CHA adds to this.
    const sellMult = 0.5 + ((cha - 8) * 0.02);

    // ... inside the list mapping ...
    // Display modified prices:
    const buyPrice = Math.ceil(item.value * buyMult);
    const sellPrice = Math.floor(item.value * sellMult);

    return (
        <div className="relative flex h-auto min-h-screen w-full flex-col p-4 sm:p-6 lg:p-8 bg-background-dark font-display overflow-y-auto">
            <div className="flex h-full w-full flex-col gap-8 rounded-lg border border-white/10 bg-black/20 p-4 sm:p-6 lg:p-8 shadow-xl backdrop-blur-sm">
                <div className="grid flex-1 grid-cols-1 gap-8 lg:grid-cols-2">
                    
                    {/* Left Column: Vendor */}
                    <div className="flex flex-col gap-6">
                        {/* Vendor Profile */}
                        <div className="flex flex-col items-start gap-4 rounded-lg bg-white/5 p-6 sm:flex-row sm:items-center border border-white/5">
                            <div 
                                className="bg-center bg-no-repeat aspect-square bg-cover rounded-full w-24 h-24 sm:w-32 sm:h-32 flex-shrink-0 border-2 border-primary/50 shadow-lg" 
                                style={{backgroundImage: `url(${transaction.vendorPortrait || 'https://placehold.co/200x200/221c10/f2a60d?text=Vendor'})`}}
                            ></div>
                            <div className="flex flex-col">
                                <h1 className="text-primary text-2xl sm:text-3xl font-bold leading-tight font-serif tracking-wide">{transaction.vendorName}</h1>
                                <p className="text-white/70 text-base font-normal leading-normal mt-2 font-landing-body">
                                    {transaction.vendorDescription}
                                </p>
                            </div>
                        </div>

                        {/* Vendor's Wares */}
                        <div className="flex h-full flex-col">
                            <h2 className="text-white text-xl sm:text-2xl font-bold leading-tight tracking-wide px-4 pb-3 pt-2 border-b border-white/10 mb-2 font-serif">Vendor's Wares</h2>
                            <div className="flex flex-col divide-y divide-white/10 rounded-lg bg-white/5 overflow-hidden border border-white/5">
                                {transaction.inventory.map((item, index) => (
                                    <div key={index} className="flex items-center gap-4 px-4 py-3 justify-between hover:bg-white/10 transition-colors duration-200 group">
                                        <div className="flex items-center gap-4">
                                            <div className="bg-center bg-no-repeat aspect-square bg-cover rounded-lg size-14 sm:size-16 bg-[#221c10] flex items-center justify-center text-white/20 border border-white/5 group-hover:border-primary/30 transition-colors">
                                                <span className="material-symbols-outlined text-3xl">shopping_bag</span>
                                            </div>
                                            <div className="flex flex-1 flex-col justify-center">
                                                <p className="text-white text-base font-medium leading-normal">{item.name}</p>
                                                <p className="text-white/60 text-sm font-normal leading-normal line-clamp-1">{item.description}</p>
                                            </div>
                                        </div>
                                        <div className="flex-shrink-0">
                                            <button 
                                                onClick={() => onTransaction(item, 'buy')}
                                                disabled={character.gold < buyPrice}
                                                className="flex min-w-[90px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-10 px-4 bg-primary/20 text-primary text-sm font-bold leading-normal w-fit hover:bg-primary/30 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-white/30"
                                            >
                                                <span className="truncate">Buy ({buyPrice}g)</span>
                                            </button>
                                        </div>
                                    </div>
                                ))}
                                {transaction.inventory.length === 0 && (
                                    <div className="p-8 text-center text-white/40 italic">Sold out!</div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Right Column: Player */}
                    <div className="flex flex-col gap-6">
                        {/* Player Gold */}
                        <div className="flex justify-between items-center rounded-lg bg-white/5 p-4 sm:p-6 border border-white/5">
                            <h3 className="text-white text-lg font-medium font-serif">Your Gold</h3>
                            <div className="flex items-center gap-2 text-primary text-xl sm:text-2xl font-bold">
                                <span className="material-symbols-outlined text-2xl sm:text-3xl">toll</span>
                                <span>{character.gold}</span>
                            </div>
                        </div>

                        {/* Player Inventory */}
                        <div className="flex h-full flex-col">
                            <h2 className="text-white text-xl sm:text-2xl font-bold leading-tight tracking-wide px-4 pb-3 pt-2 border-b border-white/10 mb-2 font-serif">Your Inventory</h2>
                            <div className="flex flex-col divide-y divide-white/10 rounded-lg bg-white/5 overflow-hidden border border-white/5">
                                {character.equipment.gear?.map((item, index) => {
                                    const sellValue = Math.floor(item.value / 2);
                                    return (
                                        <div key={index} className="flex items-center gap-4 px-4 py-3 justify-between hover:bg-white/10 transition-colors duration-200 group">
                                            <div className="flex items-center gap-4">
                                                <div className="bg-center bg-no-repeat aspect-square bg-cover rounded-lg size-14 sm:size-16 bg-[#221c10] flex items-center justify-center text-white/20 border border-white/5 group-hover:border-primary/30 transition-colors">
                                                    <span className="material-symbols-outlined text-3xl">backpack</span>
                                                </div>
                                                <div className="flex flex-1 flex-col justify-center">
                                                    <p className="text-white text-base font-medium leading-normal">{item.name}</p>
                                                    <p className="text-white/60 text-sm font-normal leading-normal line-clamp-1">{item.description}</p>
                                                </div>
                                            </div>
                                            <div className="flex-shrink-0">
                                                <button 
                                                    onClick={() => onTransaction(item, 'sell')}
                                                    className="flex min-w-[90px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-10 px-4 bg-primary/20 text-primary text-sm font-bold leading-normal w-fit hover:bg-primary/30 transition-colors duration-200"
                                                >
                                                    <span className="truncate">Sell ({sellValue}g)</span>
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                                {(!character.equipment.gear || character.equipment.gear.length === 0) && (
                                    <div className="p-8 text-center text-white/40 italic">Your bag is empty.</div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Leave Button */}
                <div className="flex justify-center pt-4 border-t border-white/10 mt-auto">
                    <button 
                        onClick={onExit}
                        className="flex min-w-[120px] max-w-[480px] cursor-pointer items-center justify-center overflow-hidden rounded-lg h-12 px-6 bg-primary text-background-dark text-base font-bold leading-normal hover:bg-yellow-400 transition-colors duration-200 shadow-lg shadow-primary/20"
                    >
                        <span className="truncate">Leave Shop</span>
                    </button>
                </div>
            </div>
        </div>
    );
};

const GameOverScreen = ({ onNewGame }: { onNewGame: () => void }) => (
    <div className="relative flex h-auto min-h-screen w-full flex-col items-center justify-center p-4 sm:p-6 lg:p-8 bg-background-dark font-display">
        <div className="flex h-full w-full max-w-2xl flex-col items-center gap-8 rounded-lg border border-white/10 bg-black/20 p-8 text-center sm:p-10 lg:p-12 shadow-2xl backdrop-blur-sm">
            <div className="flex flex-col items-center gap-4">
                <h1 className="text-primary text-5xl font-bold leading-tight sm:text-6xl lg:text-7xl font-heading drop-shadow-lg">Game Over</h1>
                <p className="text-white/70 text-lg font-normal leading-relaxed font-landing-body">
                    Your tale has come to a close. The path you walked is now a memory, a whisper in the annals of time. Though this chapter ends, the book of adventure remains open, its pages eager for a new story.
                </p>
            </div>
            <div className="w-full pt-4">
                <button 
                    onClick={onNewGame}
                    className="flex w-full min-w-[120px] max-w-xs mx-auto cursor-pointer items-center justify-center overflow-hidden rounded-lg h-14 px-8 bg-primary text-background-dark text-lg font-bold leading-normal hover:bg-yellow-400 transition-all duration-200 shadow-lg hover:scale-105"
                >
                    <span className="truncate">Start a New Journey</span>
                </button>
            </div>
        </div>
    </div>
);

const GamblingScreen = ({ gameState, onExit, onUpdateGold, onAddItem, isLoading, setIsLoading }: { 
    gameState: GameState, 
    onExit: () => void, 
    onUpdateGold: (amount: number) => void,
    onAddItem: (item: Equipment) => void,
    isLoading: boolean,
    setIsLoading: (loading: boolean) => void
}) => {
    // Local state for the UI, synced with parent if needed, but simple local state works for the session
    const [activeGame, setActiveGame] = useState<'menu' | 'dice' | 'riddle' | 'rune'>('menu');
    const [bet, setBet] = useState(10);
    const [log, setLog] = useState<{ message: string, type: string }[]>([]);
    const [riddle, setRiddle] = useState<{question: string, answer: string} | null>(null);
    const [riddleInput, setRiddleInput] = useState('');

    const character = gameState.character!;

    const addLog = (message: string, type: 'neutral' | 'win' | 'lose' | 'item' = 'neutral') => {
        setLog(prev => [{ message, type }, ...prev]);
    };

    const handleDiceRoll = () => {
        if (character.gold < bet) {
            addLog("Not enough gold!", "lose");
            return;
        }
        onUpdateGold(-bet); // Deduct bet immediately

        const roll1 = Math.floor(Math.random() * 6) + 1;
        const roll2 = Math.floor(Math.random() * 6) + 1;
        const total = roll1 + roll2;

        let message = `Rolled ${roll1} + ${roll2} = ${total}. `;
        
        if (total === 7 || total === 11) {
            const winnings = bet * 2;
            onUpdateGold(winnings);
            message += `Lucky! You win ${winnings} gold!`;
            addLog(message, 'win');
        } else if (total === 2 || total === 3 || total === 12) {
            message += `Critical fail! You lost your bet.`;
            addLog(message, 'lose');
        } else {
             message += `Push. You get your bet back.`;
             onUpdateGold(bet);
             addLog(message, 'neutral');
        }
    };

    const handleRiddleStart = async () => {
        if (character.gold < bet) {
            addLog("Not enough gold!", "lose");
            return;
        }
        setIsLoading(true);
        try {
            const response = await callGemini(
                "gemini-2.5-flash", 
                "Generate a tricky fantasy riddle. JSON format.", 
                { 
                    responseMimeType: "application/json", 
                    responseSchema: riddleSchema,
                    safetySettings: safetySettings // <--- ADD THIS LINE
                }
            );
            let data;
            if (response.text) {
                 data = JSON.parse(response.text);
            } else if (response.candidates && response.candidates[0].content.parts[0].text) {
                 data = JSON.parse(response.candidates[0].content.parts[0].text);
            }
            
            setRiddle(data);
            onUpdateGold(-bet); 
            addLog(`Riddle: ${data.question}`, 'neutral');
        } catch (e) {
            console.error("Riddle Error:", e); // Added logging
            addLog("The Riddler is silent...", 'lose');
        } finally {
            setIsLoading(false);
        }
    };

    const handleRiddleSubmit = () => {
        if (!riddle) return;
        if (riddleInput.toLowerCase().trim() === riddle.answer.toLowerCase().trim()) {
            const winnings = bet * 5;
            onUpdateGold(winnings);
            addLog(`Correct! The answer was ${riddle.answer}. You win ${winnings} gold!`, 'win');
            setRiddle(null);
            setRiddleInput('');
        } else {
            addLog(`Wrong! The answer was ${riddle.answer}. You lost your wager.`, 'lose');
            setRiddle(null);
            setRiddleInput('');
        }
    };

    const handleRuneCast = async () => {
        if (character.gold < 100) {
            addLog("Runes require a tribute of 100 gold.", "lose");
            return;
        }
        setIsLoading(true);
        onUpdateGold(-100); 

        try {
            const prompt = `
                Simulate a high-stakes rune casting game...
                (keep existing prompt text)
            `;
            const response = await callGemini(
                "gemini-2.5-flash", 
                prompt, 
                { 
                    responseMimeType: "application/json", 
                    responseSchema: runeSchema,
                    safetySettings: safetySettings // <--- ADD THIS LINE
                }
            );
            
            let data;
            if (response.text) {
                 data = JSON.parse(response.text);
            } else if (response.candidates && response.candidates[0].content.parts[0].text) {
                 data = JSON.parse(response.candidates[0].content.parts[0].text);
            }

            addLog(data.narrative, 'neutral');

            if (data.outcome === 'win_gold') {
                const winnings = Math.floor(100 * data.multiplier);
                onUpdateGold(winnings);
                addLog(`Fortune smiles! You win ${winnings} gold.`, 'win');
            } else if (data.outcome === 'win_item' && data.item) {
                onAddItem(data.item);
                addLog(`AMAZING! You received: ${data.item.name}`, 'item');
            } else if (data.outcome === 'lose_gold') {
                addLog(`The runes darken. Your tribute is consumed.`, 'lose');
            } else {
                addLog(`The runes are silent.`, 'neutral');
            }

        } catch (e) {
            console.error("Rune Error:", e); // Added logging
            addLog("The stones crack. Try again.", 'lose');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="gambling-container">
            <div className="gambling-header">
                <h1>Mystic Casino</h1>
                <div className="gambling-gold">Gold: {character.gold}</div>
                <button onClick={onExit} className="cancel-btn">Leave</button>
            </div>

            {activeGame === 'menu' ? (
                <div className="game-selection-grid">
                    <div className="game-card" onClick={() => setActiveGame('dice')}>
                        <h3>🎲 Dragon Dice</h3>
                        <p>Classic craps. Roll 7 or 11 to double your money.</p>
                    </div>
                    <div className="game-card" onClick={() => setActiveGame('riddle')}>
                        <h3>🧩 Sphinx's Riddle</h3>
                        <p>Solve the AI's riddle to win 5x your bet!</p>
                    </div>
                    <div className="game-card" onClick={() => setActiveGame('rune')}>
                        <h3>✨ Gemini Runes</h3>
                        <p>Cost: 100g. High risk, chance for Elite Gear.</p>
                    </div>
                </div>
            ) : (
                <div className="active-game-area">
                    <button onClick={() => { setActiveGame('menu'); setRiddle(null); }} style={{marginBottom: '1rem'}}>← Back to Games</button>
                    
                    {activeGame === 'dice' && (
                        <div>
                            <h2>Dragon Dice</h2>
                            <label>Wager: </label>
                            <input type="number" className="bet-input" value={bet} onChange={e => setBet(Number(e.target.value))} min={1} />
                            <button onClick={handleDiceRoll}>Roll (2d6)</button>
                        </div>
                    )}

                    {activeGame === 'riddle' && (
                        <div>
                            <h2>Sphinx's Riddle</h2>
                            {!riddle ? (
                                <div>
                                    <label>Wager: </label>
                                    <input type="number" className="bet-input" value={bet} onChange={e => setBet(Number(e.target.value))} min={1} />
                                    <button onClick={handleRiddleStart} disabled={isLoading}>Challenge the Sphinx</button>
                                </div>
                            ) : (
                                <div>
                                    <p style={{fontSize: '1.2rem', fontStyle: 'italic', margin: '1rem 0'}}>"{riddle.question}"</p>
                                    <input 
                                        type="text" 
                                        className="riddle-input" 
                                        value={riddleInput} 
                                        onChange={e => setRiddleInput(e.target.value)} 
                                        placeholder="Your answer..."
                                    />
                                    <button onClick={handleRiddleSubmit} style={{marginTop: '1rem'}}>Submit Answer</button>
                                </div>
                            )}
                        </div>
                    )}

                    {activeGame === 'rune' && (
                        <div>
                            <h2>Gemini Runes</h2>
                            <p>Cost: 100 Gold per cast.</p>
                            <button onClick={handleRuneCast} disabled={isLoading || character.gold < 100}>Cast Runes</button>
                        </div>
                    )}
                </div>
            )}

            <div className="gambling-log">
                {log.map((l, i) => (
                    <p key={i} className={l.type}>&gt; {l.message}</p>
                ))}
            </div>
        </div>
    );
};

const AuthScreen = ({ onLogin }: { onLogin: () => void }) => (
    <div className="auth-container">
        <h1><img src="/ea-logo.png" style={{height: '3rem', verticalAlign: 'middle'}}/> Aethelgard's Echo</h1>
        <p>Sign in to save your progress to the cloud and play with friends.</p>
        <button onClick={onLogin} className="google-btn">
            Sign in with Google
        </button>
    </div>
);

const LobbyBrowser = ({ 
    onJoin, 
    onCreate, 
    onSinglePlayer, 
    onBack 
}: { 
    onJoin: (id: string) => void, 
    onCreate: () => void, 
    onSinglePlayer: () => void, 
    onBack: () => void 
}) => {
    const [joinId, setJoinId] = useState('');

    return (
        <div className="relative flex min-h-screen w-full flex-col items-center justify-center bg-background-dark font-display p-4">
            <div className="absolute inset-0 z-0 bg-cover bg-center opacity-40" style={{backgroundImage: 'url("https://images.unsplash.com/photo-1633478062482-790e3b5dd810?q=80&w=2000&auto=format&fit=crop")'}}></div>
            <div className="absolute inset-0 z-0 bg-gradient-to-t from-background-dark via-background-dark/80 to-transparent"></div>

            <div className="relative z-10 w-full max-w-4xl flex flex-col gap-8">
                <div className="text-center space-y-2">
                    <h1 className="text-4xl md:text-5xl font-black text-white font-heading tracking-tight drop-shadow-lg">Campaign Selection</h1>
                    <p className="text-[#bab09c] text-lg">Choose how your story unfolds.</p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Single Player Card */}
                    <div className="group relative flex flex-col justify-between overflow-hidden rounded-xl border border-white/10 bg-[#181611]/80 p-6 backdrop-blur-md transition-all hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10">
                        <div className="space-y-4">
                            <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center text-primary border border-white/10 group-hover:bg-primary/20 group-hover:border-primary/30 transition-colors">
                                <span className="material-symbols-outlined text-3xl">person</span>
                            </div>
                            <div>
                                <h3 className="text-2xl font-bold text-white font-serif">Solo Journey</h3>
                                <p className="text-gray-400 mt-2 leading-relaxed">Embark on a personal quest where every decision rests solely on your shoulders.</p>
                            </div>
                        </div>
                        <button onClick={onSinglePlayer} className="mt-8 w-full py-3 rounded-lg bg-white/5 border border-white/10 text-white font-bold hover:bg-white/10 transition-all">
                            Play Solo
                        </button>
                    </div>

                    {/* Multiplayer Host Card */}
                    <div className="group relative flex flex-col justify-between overflow-hidden rounded-xl border border-white/10 bg-[#181611]/80 p-6 backdrop-blur-md transition-all hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10">
                        <div className="space-y-4">
                            <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center text-primary border border-white/10 group-hover:bg-primary/20 group-hover:border-primary/30 transition-colors">
                                <span className="material-symbols-outlined text-3xl">swords</span>
                            </div>
                            <div>
                                <h3 className="text-2xl font-bold text-white font-serif">Host Campaign</h3>
                                <p className="text-gray-400 mt-2 leading-relaxed">Create a shared world. Invite friends to join your party and shape the story together.</p>
                            </div>
                        </div>
                        <button onClick={onCreate} className="mt-8 w-full py-3 rounded-lg bg-primary text-background-dark font-bold hover:bg-yellow-500 transition-all shadow-lg shadow-primary/20">
                            Create Lobby
                        </button>
                    </div>
                </div>

                {/* Join Section */}
                <div className="rounded-xl border border-white/10 bg-[#181611]/90 p-6 backdrop-blur-md flex flex-col md:flex-row items-center gap-6 justify-between">
                    <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center text-[#bab09c]">
                            <span className="material-symbols-outlined">login</span>
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-white">Join Existing Party</h3>
                            <p className="text-sm text-gray-400">Enter a Lobby ID to join a friend's game.</p>
                        </div>
                    </div>
                    <div className="flex w-full md:w-auto gap-2">
                        <input 
                            type="text" 
                            placeholder="Lobby ID..." 
                            value={joinId} 
                            onChange={e => setJoinId(e.target.value)}
                            className="flex-1 md:w-64 bg-black/30 border border-[#544c3b] rounded-lg px-4 py-2 text-white placeholder:text-gray-600 focus:border-primary focus:ring-1 focus:ring-primary outline-none"
                        />
                        <button 
                            onClick={() => onJoin(joinId)} 
                            disabled={!joinId.trim()}
                            className="px-6 py-2 bg-white/10 text-white font-bold rounded-lg hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all border border-white/10"
                        >
                            Join
                        </button>
                    </div>
                </div>

                <div className="flex justify-center">
                    <button onClick={onBack} className="flex items-center gap-2 text-[#bab09c] hover:text-white transition-colors px-4 py-2">
                        <span className="material-symbols-outlined">arrow_back</span> Back to Menu
                    </button>
                </div>
            </div>
        </div>
    );
};

const WaitingRoom = ({ lobby, onStart, onLeave }: { lobby: MultiplayerLobby, onStart: () => void, onLeave?: () => void }) => {
    const copyToClipboard = () => {
        navigator.clipboard.writeText(lobby.id);
        // Could add a small toast here
    };

    return (
        <div className="relative flex min-h-screen w-full flex-col items-center justify-center bg-background-dark font-display p-4">
            <div className="absolute inset-0 z-0 bg-cover bg-center opacity-20" style={{backgroundImage: 'url("https://images.unsplash.com/photo-1533174072545-e8d4aa97edf9?q=80&w=2000&auto=format&fit=crop")'}}></div>
            
            <div className="relative z-10 w-full max-w-3xl bg-[#181611]/95 border border-[#544c3b] rounded-xl shadow-2xl p-8 flex flex-col gap-8">
                
                {/* Header */}
                <div className="text-center border-b border-white/10 pb-6">
                    <h2 className="text-3xl font-bold text-white font-serif tracking-wide">{lobby.name}</h2>
                    <div className="flex items-center justify-center gap-3 mt-4">
                        <span className="text-[#bab09c] uppercase text-xs font-bold tracking-widest">Lobby ID</span>
                        <div className="flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded border border-white/10 cursor-pointer hover:border-primary/50 transition-colors" onClick={copyToClipboard} title="Click to copy">
                            <code className="text-primary font-mono text-sm">{lobby.id}</code>
                            <span className="material-symbols-outlined text-xs text-gray-500">content_copy</span>
                        </div>
                    </div>
                </div>

                {/* Player Grid */}
                <div className="space-y-3">
                    <h3 className="text-white font-bold flex items-center gap-2">
                        <span className="material-symbols-outlined text-primary">group</span> 
                        Party Members ({lobby.players.length}/4)
                    </h3>
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {lobby.players.map(p => (
                            <div key={p.uid} className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/5">
                                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-background-dark ${p.isHost ? 'bg-primary' : 'bg-gray-400'}`}>
                                    {p.displayName.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                    <div className="flex items-center gap-2">
                                        <p className="text-white font-bold text-sm">{p.displayName}</p>
                                        {p.isHost && <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded border border-primary/20">HOST</span>}
                                    </div>
                                    <p className="text-xs text-gray-500">{p.isReady ? 'Ready' : 'Connecting...'}</p>
                                </div>
                            </div>
                        ))}
                        {/* Empty Slots */}
                        {[...Array(Math.max(0, 4 - lobby.players.length))].map((_, i) => (
                            <div key={i} className="flex items-center gap-3 p-3 rounded-lg border border-dashed border-white/10 text-white/20">
                                <div className="w-10 h-10 rounded-full border-2 border-dashed border-white/10 flex items-center justify-center">
                                    <span className="material-symbols-outlined">add</span>
                                </div>
                                <p className="text-sm font-medium">Empty Slot</p>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col sm:flex-row gap-4 pt-6 border-t border-white/10">
                    {onLeave && (
                        <button onClick={onLeave} className="flex-1 py-3 rounded-lg border border-[#544c3b] text-[#bab09c] font-bold hover:bg-[#221c10] hover:text-white transition-colors">
                            Leave Party
                        </button>
                    )}
                    
                    {/* Only Host can see Start button usually, but based on your logic it seems anyone can click? Assuming logic is handled in App */}
                    <button 
                        onClick={onStart} 
                        disabled={lobby.players.length < 1}
                        className="flex-1 py-3 rounded-lg bg-primary text-background-dark font-bold hover:bg-yellow-500 transition-all shadow-lg shadow-primary/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        <span>Begin Adventure</span>
                        <span className="material-symbols-outlined text-lg">arrow_forward</span>
                    </button>
                </div>
                
                <p className="text-center text-xs text-gray-600">
                    Waiting for party leader to start...
                </p>
            </div>
        </div>
    );
};

const LevelUpScreen = ({ character, skillPools, onComplete }: { character: Character, skillPools: SkillPools, onComplete: (skills: any, stats: any) => void }) => {
    const [stats, setStats] = useState(character.stats);
    const [statPoints, setStatPoints] = useState(1); // "get 1 stat point every level"
    
    const [skills, setSkills] = useState(character.skills);
    const [skillPoints, setSkillPoints] = useState(character.skillPoints); // Existing points

    const handleStatChange = (stat: keyof CharacterStats, change: number) => {
        if (change > 0 && statPoints <= 0) return;
        // Don't allow reducing below original value
        if (change < 0 && stats[stat] <= character.stats[stat]) return;
        
        setStats(p => ({ ...p, [stat]: p[stat] + change }));
        setStatPoints(p => p - change);
    };

    // ... (Reuse SkillAllocator logic here or just render it differently) ...
    // For brevity, I'll return a simplified UI combining both.
    
    return (
        <div className="relative flex min-h-screen w-full flex-col bg-background-dark font-display p-8 overflow-y-auto">
            <h1 className="text-3xl text-white font-bold text-center mb-8">Level Up Reached!</h1>
            
            <div className="max-w-4xl mx-auto w-full grid gap-8">
                {/* Stat Section */}
                <section>
                    <h2 className="text-xl text-primary mb-4">1. Improve Attributes ({statPoints} pts)</h2>
                    <StatAllocator 
                        stats={stats} 
                        pointsRemaining={statPoints} 
                        onStatChange={handleStatChange}
                    />
                </section>

                {/* Skill Section */}
                <section>
                    <h2 className="text-xl text-primary mb-4">2. Train Skills ({skillPoints} pts)</h2>
                    {/* ... Insert Skill List UI here (reused from SkillAllocator) ... */}
                    <p className="text-gray-400 italic">Skill training UI placeholder - Implement using SkillAllocator logic</p>
                </section>

                <button 
                    onClick={() => onComplete(skills, stats)} 
                    disabled={statPoints > 0} // Force spending stat point?
                    className="py-4 bg-primary text-background-dark font-bold rounded text-xl hover:bg-yellow-500 disabled:opacity-50"
                >
                    Confirm Level Up
                </button>
            </div>
        </div>
    );
};

// --- MAIN APP ---

const App = () => {
  // 1. STATE DEFINITIONS
  const [user, setUser] = useState<User | null>(null);
  const [lobbyId, setLobbyId] = useState<string | null>(null);
  const [isMultiplayer, setIsMultiplayer] = useState(false);
  const [lobbyData, setLobbyData] = useState<MultiplayerLobby | null>(null);
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
      combat: null,
      loot: null,
      transaction: null,
      map: null,
  });
  const [creationData, setCreationData] = useState<CreationData | null>(null);
  const [apiIsLoading, setApiIsLoading] = useState(false);
  const [isCustomActionModalOpen, setIsCustomActionModalOpen] = useState(false);

  // NEW STATE for Multiple Saves
  const [savedGames, setSavedGames] = useState<SavedGame[]>([]);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [view, setView] = useState<'landing' | 'loading' | 'menu' | 'load_menu' | 'creation' | 'game' | 'lobby'>('landing');

  // 1. Add this new state near other useState calls
  const [showLobbySelect, setShowLobbySelect] = useState(false);

  // 3. CALLBACKS & HELPER FUNCTIONS
  const fetchSavedGames = async (uid: string) => {
      const gamesRef = collection(db, "users", uid, "games");
      const snapshot = await getDocs(gamesRef);
      
      const games: SavedGame[] = snapshot.docs
          .map(doc => {
              const data = doc.data();
              if (!data.gameState || !data.gameState.character) return null;

              return {
                  id: doc.id,
                  name: data.gameState.character.name,
                  characterClass: data.creationData?.characterClass || "Adventurer",
                  level: Math.max(1, Object.values(data.gameState.character.skills || {}).reduce((a: number, b: number) => a + b, 0) - 5),
                  lastPlayed: data.lastUpdated,
                  gameState: data.gameState,
                  creationData: data.creationData
              };
          })
          .filter((g): g is SavedGame => g !== null);
      
      setSavedGames(games);

      // --- FIX IS HERE: Check for 'landing' OR 'loading' ---
      if (view === 'loading' || view === 'landing') {
          setView('menu');
      }
      // ----------------------------------------------------
  };

  const handleLogin = async () => {
      try {
          await signInWithPopup(auth, googleProvider);
      } catch (error) {
          console.error("Login failed", error);
      }
  };

  const uploadImageToStorage = async (base64Data: string, path: string): Promise<string> => {
        if (!base64Data || !base64Data.startsWith('data:image')) return base64Data;
        try {
            const storageRef = ref(storage, path);
            await uploadString(storageRef, base64Data, 'data_url');
            return await getDownloadURL(storageRef);
        } catch (error) {
            console.error("Upload failed:", error);
            return base64Data; 
        }
  };

  const generateImage = useCallback(async (prompt: string): Promise<string | null> => {
    try {
        // 1. Sanitize Prompt (Keep existing logic)
        const promptResponse = await callGemini("gemini-2.5-flash", `Create a concise image prompt for fantasy art: ${prompt}`, { responseMimeType: "application/json", responseSchema: imagePromptSchema, safetySettings });
        let jsonText = "";
        if (promptResponse.text) {
             jsonText = promptResponse.text;
        } else if (promptResponse.candidates && promptResponse.candidates[0].content.parts[0].text) {
             jsonText = promptResponse.candidates[0].content.parts[0].text;
        }
        const finalPrompt = JSON.parse(jsonText).prompt;

        // 2. Generate Image with GEMINI 2.5 FLASH (Nano Banana)
        const imageResponse = await callImagen(
            'gemini-2.5-flash-image', 
            `fantasy art. ${finalPrompt}`, 
            { 
                // --- FIX IS HERE: REMOVE responseMimeType ---
                // We leave this empty or pass safetySettings if needed.
                // The model automatically returns the image in the correct format.
            }
        );
        
        // 3. Parse New Response Format
        const candidate = imageResponse.candidates?.[0];
        const part = candidate?.content?.parts?.find((p: any) => p.inlineData);
        
        if (!part || !part.inlineData || !part.inlineData.data) {
            console.warn("No image data found in response");
            return null;
        }

        const base64Image = `data:image/jpeg;base64,${part.inlineData.data}`;
        
        // 4. Upload (Keep existing logic)
        if (auth.currentUser) {
            const path = `users/${auth.currentUser.uid}/generated/img_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
            return await uploadImageToStorage(base64Image, path);
        }
        return base64Image;
    } catch (error) {
        console.error("Image generation failed:", error);
        return null;
    }
  }, []);

  const saveGameToCloud = async (stateToSave: any) => {
      if (!user || !activeCharacterId) return;
      
      if (isMultiplayer && lobbyId) {
          // Update the shared lobby state
          await updateDoc(doc(db, "lobbies", lobbyId), { 
              gameState: stateToSave 
          });
      } else {
          // Update the user's private save file
          await setDoc(doc(db, "users", user.uid, "games", activeCharacterId), {
              gameState: stateToSave,
              creationData: creationData, // It's okay if this is null/undefined now, Firestore will ignore it or handle it
              lastUpdated: serverTimestamp()
          }, { merge: true });
      }
  };

  // Character Select Handlers
  const handleCharacterSelect = (save: SavedGame) => {
      setGameState(save.gameState);
      setCreationData(save.creationData || null);
      setActiveCharacterId(save.id);
      
      // --- FIX: Force Single Player ---
      setIsMultiplayer(false);
      setLobbyId(null);
      // --------------------------------
      
      setView('game');
  };

  const handleDeleteCharacter = async (id: string) => {
      if (!user || !confirm("Delete this character?")) return;
      await deleteDoc(doc(db, "users", user.uid, "games", id));
      setSavedGames(prev => prev.filter(g => g.id !== id));
  };

  const handleStartCreation = () => {
      setActiveCharacterId(null);
      
      // --- FIX: Force Single Player ---
      setIsMultiplayer(false);
      setLobbyId(null);
      // --------------------------------

      setGameState(prevState => ({
        ...prevState,
        character: null,
        companions: [],
        storyLog: [],
        gameStatus: 'characterCreation'
      }));
      setCreationData(null);
      setView('creation');
  };

  const handleBackToMenu = () => {
      setActiveCharacterId(null);
      setIsMultiplayer(false);
      setLobbyId(null);
      if (user) fetchSavedGames(user.uid);
      setView('menu'); // This now goes to the new Main Menu
  };

  const handleCreateLobby = async () => {
      if (!user) return;
      const newLobby: any = {
          hostUid: user.uid,
          name: `${user.displayName}'s Adventure`,
          players: [{
              uid: user.uid,
              displayName: user.displayName || "Hero",
              isHost: true,
              isReady: true
          }],
          status: 'waiting',
          currentTurnIndex: 0,
          createdAt: serverTimestamp()
      };
      
      const docRef = await addDoc(collection(db, "lobbies"), newLobby);
      setLobbyId(docRef.id);
      setIsMultiplayer(true);
      setGameState(prev => ({ ...prev, gameStatus: 'initial_load' }));
  };

  // 2. Add this new handler function
  const handleLobbyCharacterSelect = async (save: SavedGame) => {
      if (!lobbyId) return;
      
      // Load the save locally
      setGameState(save.gameState);
      setCreationData(save.creationData || null);
      setActiveCharacterId(save.id); // Link to the save ID (optional for MP but good for reference)

      // Update the Lobby to start the game with this data
      await updateDoc(doc(db, "lobbies", lobbyId), {
          gameState: save.gameState,
          creationData: save.creationData || null,
          status: 'playing',
          currentTurnIndex: 0
      });

      setShowLobbySelect(false);
      setView('game');
  };

  const handleCreateCharacter = useCallback(async (details: CreationDetails & { stats: CharacterStats }) => {
    setApiIsLoading(true);
    setGameState(g => ({...g, gameStatus: 'loading'}));

    const { name, gender, race, characterClass, background, campaign } = details;

    try {
        const prompt = `
            Generate a fantasy character, story guidance, skill pools, an opening scene, and an initial world map for a text adventure game.
            The world is named Aerthos. The capital kingdom is Aethelgard.
            The player has defined their character with the following attributes:
            - Name: '${name}'
            - Gender: ${gender}
            - Race: ${race}
            - Class: ${characterClass}
            - Background: ${background}
            - Desired Campaign Type: ${campaign}

            The character has these stats: STR ${details.stats.str}, DEX ${details.stats.dex}, CON ${details.stats.con}, INT ${details.stats.int}, CHA ${details.stats.int}, WIS ${details.stats.wis}

            Base the character's description, the initial story, the plot, and the available skill pools on all of these attributes.
            IMPORTANT: For the map, generate 5-7 key starting locations in the world of Aerthos, including Aethelgard. Populate the 'map.locations' array and specify which of these is the 'map.startingLocationName'.
            The initial story text must mention the starting location by name.
            Generate a set of starting equipment for the character and their companions, making it unique and appropriate.
            IMPORTANT: For the companions, please generate unique names and personalities. Avoid using the names Kaelen, Lyra, Elara, and Gorok.
            Include map, skill pools, and companions.
            IMPORTANT: For the 'skillPools', you MUST provide a 'description' for every single skill, explaining what it does in fantasy terms.
        `;
        const response = await callGemini(
            "gemini-2.5-flash",
            prompt,
            {
                responseMimeType: "application/json",
                responseSchema: characterGenSchema,
                safetySettings: safetySettings,
            },
        );

        let data;
        if (response.text && typeof response.text === 'string') {
            data = JSON.parse(response.text);
        } else {
            data = JSON.parse(response.candidates[0].content.parts[0].text);
        }

        const initialCompanions: Companion[] = data.companions.map((comp: any) => {
            const skillsObject = comp.skills.reduce((acc: { [key: string]: number }, skill: { skillName: string, level: number }) => {
                acc[skill.skillName] = skill.level;
                return acc;
            }, {});

            return {
                ...comp,
                skills: skillsObject,
                alignment: comp.alignment,
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
            startingSkillPoints: data.startingSkillPoints,
            startingEquipment: data.startingEquipment,
            background: details.background,
            startingAlignment: data.character.alignment || { lawfulness: 0, goodness: 0 }, 
            startingMap: data.map,
            characterClass: details.characterClass,
            startingStats: details.stats
        });
        setGameState(g => ({...g, companions: initialCompanions, gameStatus: 'characterCustomize'}));

    } catch (error) {
        console.error("Character creation failed:", error);
        handleStartCreation();
    } finally {
        setApiIsLoading(false);
    }
  }, []);

  const handleFinalizeCharacter = useCallback(async (chosenSkills: {[key: string]: number}) => {
     if (!creationData || !user) return; // Safety check
     setApiIsLoading(true);
     setGameState(g => ({...g, gameStatus: 'loading'}));

     try {
        const mapImagePrompt = `An antique, hand-drawn fantasy map of the world of Aerthos. It should depict the following locations: ${creationData.startingMap.locations.map(l => l.name).join(', ')}. The map should have a vintage, weathered look, with a compass rose and perhaps some sea monsters in the oceans.`;

        const [portrait, illustration, mapImage] = await Promise.all([
            generateImage(creationData.description),
            generateImage(`${creationData.storyGuidance.setting}. ${creationData.initialStory.text}`),
            generateImage(mapImagePrompt)
        ]);

        const finalLocations: MapLocation[] = creationData.startingMap.locations.map(loc => ({
            ...loc,
            visited: loc.name === creationData.startingMap.startingLocationName
        }));

        let startingGold = Math.floor(Math.random() * 100) + 1;
        if (["Noble", "Royalty", "Merchant"].includes(creationData.background)) {
            startingGold = Math.floor(Math.random() * 1000) + 1;
        } else if (creationData.background === "Commoner") {
            startingGold = Math.floor(Math.random() * 10) + 1;
        }

        const newCharacter: Character = {
            name: creationData.name,
            gender: creationData.gender,
            hp: 100,
            maxHp: 100,
            xp: 0,
            skills: chosenSkills,
            skillPoints: 0,
            stats: creationData.startingStats,
            description: creationData.description,
            portrait: portrait,
            alignment: creationData.startingAlignment,
            reputation: {},
            equipment: creationData.startingEquipment,
            gold: startingGold,
        };
        const initialSegment: StorySegment = { text: creationData.initialStory.text, illustration };

        const newGameState: GameState = {
            ...gameState,
            character: newCharacter,
            storyGuidance: creationData.storyGuidance,
            skillPools: creationData.skillPools,
            storyLog: [{ text: creationData.initialStory.text, illustration }],
            currentActions: creationData.initialStory.actions,
            map: { backgroundImage: mapImage, locations: finalLocations },
            gameStatus: 'playing',
            companions: gameState.companions
        };

        // --- SAVING LOGIC ---
        if (isMultiplayer && lobbyId) {
            await updateDoc(doc(db, "lobbies", lobbyId), {
                gameState: newGameState,
                creationData: creationData,
                status: 'playing' 
            });
        } else {
            const newId = `${creationData.name.replace(/\s+/g, '_')}_${Date.now()}`;
            await setDoc(doc(db, "users", user.uid, "games", newId), {
                gameState: newGameState,
                creationData: creationData,
                lastUpdated: serverTimestamp()
            });
            setActiveCharacterId(newId);
            setGameState(newGameState);
            setView('game');
        }
        
     } catch (error) {
        console.error("Character finalization failed:", error);
        setView('creation'); // Go back on error
     } finally {
         setApiIsLoading(false);
     }
  }, [creationData, generateImage, user, isMultiplayer, gameState, lobbyId]);

  const calculateStatBonus = (value: number): number => {
        if (value <= 0) return 0;
        if (value <= 4) return 1;
        if (value <= 8) return 2;
        if (value <= 12) return 4;
        if (value <= 16) return 8;
        if (value <= 20) return 16;
        
        // For 21+, it increases by 4% for every 4 points
        // 21-24 = 20%, 25-28 = 24%, etc.
        const excess = value - 20;
        const steps = Math.ceil(excess / 4);
        return 16 + (steps * 4);
    };

    const getSkillCategory = (skillName: string, skillPools: SkillPools | null): 'Combat' | 'Magic' | 'Utility' | null => {
        if (!skillPools) return null;
        if (skillPools.Combat.some(s => s.name === skillName)) return 'Combat';
        if (skillPools.Magic.some(s => s.name === skillName)) return 'Magic';
        if (skillPools.Utility.some(s => s.name === skillName)) return 'Utility';
        return null;
    };

    const getSkillCheckModifier = (skillName: string, stats: CharacterStats, skillPools: SkillPools | null): number => {
        const category = getSkillCategory(skillName, skillPools);
        let bonus = 0;

        if (category === 'Combat') {
            // Combat affected by STR and CON
            bonus = calculateStatBonus(stats.str) + calculateStatBonus(stats.con);
        } else if (category === 'Magic') {
            // Magic affected by INT and WIS
            bonus = calculateStatBonus(stats.int) + calculateStatBonus(stats.wis);
        } else if (category === 'Utility') {
            // Utility affected by CHA and DEX
            bonus = calculateStatBonus(stats.cha) + calculateStatBonus(stats.dex);
        }
        
        return bonus;
    };

  const handleAction = useCallback(async (action: string) => {
    if (!gameState.character || !gameState.storyGuidance || apiIsLoading) return;
    setApiIsLoading(true);

    if (isMultiplayer && lobbyId && lobbyData) {
        const currentPlayerIndex = lobbyData.currentTurnIndex % lobbyData.players.length;
        const currentPlayer = lobbyData.players[currentPlayerIndex];
        if (currentPlayer.uid !== user?.uid) {
            alert(`It is ${currentPlayer.displayName}'s turn!`);
            setApiIsLoading(false);
            return;
        }
        await updateDoc(doc(db, "lobbies", lobbyId), { currentTurnIndex: lobbyData.currentTurnIndex + 1 });
    }

    try {
        const storyHistory = gameState.storyLog.map(s => s.text).join('\n\n');
        const companionsDetails = gameState.companions.map(c =>
            `  - Name: ${c.name}, Personality: ${c.personality}, Relationship: ${c.relationship}`
        ).join('\n');

        const skillListWithBonuses = Object.entries(gameState.character.skills).map(([skill, level]) => {
            const bonus = getSkillCheckModifier(skill, gameState.character.stats, gameState.skillPools);
            return `${skill} (Lvl ${level}, Stat Bonus: +${bonus}%)`;
        }).join(', ');

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
            STATS: STR ${gameState.character.stats.str}, DEX ${gameState.character.stats.dex}, CON ${gameState.character.stats.con}, WIS ${gameState.character.stats.wis}, INT ${gameState.character.stats.int}, CHA ${gameState.character.stats.cha}
            SKILLS & BONUSES:
            ${skillListWithBonuses}
            Reputation: ${JSON.stringify(gameState.character.reputation)}
            Companions:
            ${companionsDetails}
            Description: ${gameState.character.description}
            Equipment:
            - Weapon: ${gameState.character.equipment.weapon?.name} (Damage: ${gameState.character.equipment.weapon?.stats.damage})
            - Armor: ${gameState.character.equipment.armor?.name} (Damage Reduction: ${gameState.character.equipment.armor?.stats.damageReduction})
            - Gear: ${gameState.character.equipment.gear?.map(g => g.name).join(', ')}

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
            If the player discovers a new location, add it to the 'mapUpdate.newLocations' array. Also, if the player travels to a location, update 'mapUpdate.updateVisited' with the location's name.

            If the player's action is related to a specific skill (e.g., 'Use magic to create a diversion' or 'Try to disarm the guard'), perform a skill check. 
            **CRITICAL RULE:** You must apply the "Stat Bonus" percentage listed in the SKILLS section to the success probability. 
            (e.g. If base chance is 50% and Stat Bonus is +16%, the success chance becomes 66%).
            Populate the 'skillCheck' field with the results.

            Update companion relationships if their opinion of the player changes. If the story presents an opportunity, you can introduce a *new* character for the player to potentially recruit by populating the 'newCompanion' field.
            Use the 'equipmentUpdates' field to change the character's gear. An update can be to 'add', 'remove', 'replace', 'update' an item. Be sure to provide the full details of the new item and its stats.
            If the action leads to a fight, set 'initiateCombat' to true and provide a list of enemies.
            If the action leads to a transaction with a merchant, set 'initiateTransaction' to true and provide the vendor's details and inventory.
        `;

        const response = await callGemini(
            "gemini-2.5-flash",
            prompt,
            {
                responseMimeType: "application/json",
                responseSchema: nextStepSchema,
                safetySettings: safetySettings,
            },
        );

        let data;
        if (response.text && typeof response.text === 'string') {
            data = JSON.parse(response.text).story;
        } else {
            data = JSON.parse(response.candidates[0].content.parts[0].text).story;
        }
        if (data.initiateCombat && data.enemies && data.enemies.length > 0) {
            const enemyPortraits = await Promise.all(
                data.enemies.map((enemy: any) => generateImage(enemy.description))
            );
            const enemies: Enemy[] = data.enemies.map((enemy: any, index: number) => ({
                id: `${enemy.name}-${index}`,
                name: enemy.name,
                hp: enemy.hp,
                maxHp: enemy.hp,
                description: enemy.description,
                portrait: enemyPortraits[index],
            }));
            const combatLog: CombatLogEntry[] = [{
                type: 'info',
                message: data.text
            }];

            setGameState(prevState => {
                if (!prevState.character) return prevState;
                const combatIntroSegment: StorySegment = {
                    text: data.text,
                    illustration: null,
                };
                return {
                    ...prevState,
                    gameStatus: 'combat',
                    combat: {
                        enemies,
                        log: combatLog,
                        turn: 'player',
                        availableActions: data.actions || ['Attack', 'Defend', 'Use Skill']
                    },
                    storyLog: [...prevState.storyLog, combatIntroSegment],
                }
            });
        } else if (data.initiateTransaction) {
            const vendorPortrait = await generateImage(data.transaction.vendorDescription);
            setGameState(prevState => ({
                ...prevState,
                gameStatus: 'transaction',
                transaction: {
                    ...data.transaction,
                    vendorPortrait,
                }
            }));
        } else {
            const newIllustration = await generateImage(`${gameState.storyGuidance.setting}. ${data.text}`);
            const newSegment: StorySegment = {
                text: data.text,
                illustration: newIllustration,
                skillCheck: data.skillCheck
            };
            setGameState(prevState => {
                if (!prevState.character) return prevState;
                const updatedCompanions = [...prevState.companions];
                const oldXp = prevState.character.xp;
                const newXp = oldXp + data.didXpChange;
                const earnedSkillPoints = Math.floor(newXp / 100) - Math.floor(oldXp / 100);
                const newAlignment = { ...prevState.character.alignment };
                if (data.alignmentChange) {
                    newAlignment.lawfulness = Math.max(-100, Math.min(100, newAlignment.lawfulness + data.alignmentChange.lawfulness));
                    newAlignment.goodness = Math.max(-100, Math.min(100, newAlignment.goodness + data.alignmentChange.goodness));
                }
                const newReputation = { ...prevState.character.reputation };
                if (data.reputationChange) {
                    for (const [faction, change] of Object.entries(data.reputationChange)) {
                        newReputation[faction] = (newReputation[faction] || 0) + change;
                    }
                }

                const updatedEquipment = { ...prevState.character.equipment };
                if (data.equipmentUpdates) {
                    for (const update of data.equipmentUpdates) {
                        const newEquipmentItem: Equipment = {
                            name: update.name,
                            description: update.description,
                            stats: update.stats,
                            value: update.value,
                        };
                        if (update.slot === 'weapon') {
                            updatedEquipment.weapon = newEquipmentItem;
                        } else if (update.slot === 'armor') {
                            updatedEquipment.armor = newEquipmentItem;
                        } else if (update.slot === 'gear') {
                            if (update.action === 'add') {
                                 updatedEquipment.gear = [...(updatedEquipment.gear || []), newEquipmentItem];
                            }
                        }
                    }
                }

                const updatedMap = prevState.map ? { ...prevState.map, locations: [...prevState.map.locations] } : null;
                if (updatedMap && data.mapUpdate) {
                    if (data.mapUpdate.newLocations) {
                        data.mapUpdate.newLocations.forEach((newLoc: any) => {
                            if (!updatedMap.locations.some(l => l.name === newLoc.name)) {
                                updatedMap.locations.push({ ...newLoc, visited: false });
                            }
                        });
                    }
                    if (data.mapUpdate.updateVisited) {
                        const locIndex = updatedMap.locations.findIndex(l => l.name === data.mapUpdate.updateVisited);
                        if (locIndex !== -1) {
                            updatedMap.locations[locIndex].visited = true;
                        }
                    }
                }

                updatedCompanions.forEach(comp => {
                    if(data.alignmentChange) {
                        const lawfulnessDiff = Math.abs(newAlignment.lawfulness - comp.alignment.lawfulness);
                        const goodnessDiff = Math.abs(newAlignment.goodness - comp.alignment.goodness);
                        if (lawfulnessDiff > Math.abs(prevState.character.alignment.lawfulness - comp.alignment.lawfulness) ||
                            goodnessDiff > Math.abs(prevState.character.alignment.goodness - comp.alignment.goodness)) {
                            comp.relationship -= 1;
                        }
                    }
                });

                const updatedCharacter = {
                    ...prevState.character,
                    hp: prevState.character.hp + data.didHpChange,
                    xp: newXp,
                    skillPoints: prevState.character.skillPoints + earnedSkillPoints,
                    alignment: newAlignment,
                    reputation: newReputation,
                    equipment: updatedEquipment,
                };

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
                    map: updatedMap,
                };
            });
        }

        const newStoryLogLength = gameState.storyLog.length + 1;
        if (newStoryLogLength > 0 && newStoryLogLength % 10 === 0) {
            const oldSummary = gameState.character?.storySummary || "The story has just begun.";
            const recentEvents = [...gameState.storyLog].slice(-10).map(s => s.text).join('\n\n');

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

            const summaryResponse = await callGemini(
                "gemini-2.5-flash",
                summaryPrompt,
                {
                    responseMimeType: "application/json",
                    responseSchema: storySummarySchema,
                    safetySettings: safetySettings
                },
            );

            let summaryData;
            if (summaryResponse.text && typeof summaryResponse.text === 'string') {
                summaryData = JSON.parse(summaryResponse.text);
            } else {
                summaryData = JSON.parse(summaryResponse.candidates[0].content.parts[0].text);
            }

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
  }, [gameState, generateImage, apiIsLoading, isMultiplayer, lobbyId, lobbyData, user]);

  const handleCombatAction = useCallback(async (action: string) => {
    if (!gameState.character || !gameState.combat || apiIsLoading) return;
    setApiIsLoading(true);

    try {
        // Calculate Modifiers
        const strMod = Math.floor((gameState.character.stats.str - 8) / 2); // Base 8
        const dexMod = Math.floor((gameState.character.stats.dex - 8) / 2);
        const wisMod = Math.floor((gameState.character.stats.wis - 8) / 2);
        const dodgeChance = Math.min(50, gameState.character.stats.dex * 1.5); // 1.5% per point

        const prompt = `
            You are the dungeon master in a text-based RPG. The player is in combat.
            Player's action: "${action}"

            CHARACTER:
            Name: ${gameState.character.name}
            HP: ${gameState.character.hp}
            Skills: ${Object.entries(gameState.character.skills).map(([skill, level]) => `${skill} (Lvl ${level})`).join(', ')}
            Equipment:
            - Weapon: ${gameState.character.equipment.weapon?.name} (Damage: ${gameState.character.equipment.weapon?.stats.damage})
            - Armor: ${gameState.character.equipment.armor?.name} (Damage Reduction: ${gameState.character.equipment.armor?.stats.damageReduction})

            CHARACTER STATS:
            STR: ${gameState.character.stats.str} (Melee Bonus: ${strMod >= 0 ? '+' : ''}${strMod})
            DEX: ${gameState.character.stats.dex} (Ranged Bonus: ${dexMod >= 0 ? '+' : ''}${dexMod}, Dodge Chance: ${dodgeChance}%)
            WIS: ${gameState.character.stats.wis} (Magic Bonus: ${wisMod >= 0 ? '+' : ''}${wisMod})
            
            RULES:
            - If player uses MELEE, add ${strMod} to damage.
            - If player uses RANGED, add ${dexMod} to damage.
            - If player uses MAGIC, add ${wisMod} to damage.
            - Enemies have a ${dodgeChance}% chance to MISS the player completely (describe as a dodge).

            ENEMIES:
            ${gameState.combat.enemies.map(e => `- ID: ${e.id}, Name: ${e.name} (HP: ${e.hp})`).join('\n')}

            TASK:
            Process the player's action and the enemies' turn. Return the result of the turn.
            - When the player attacks, determine the most relevant combat skill from their skill list.
            - Calculate a damage multiplier based on the level of that skill. The formula for the multiplier is as follows:
              - Level 1: 1x, Level 2: 1.2x, Level 3: 1.4x, Level 4: 1.8x, Level 5: 2.6x, Level 6: 4.2x
              - For levels above 6, the difference from the previous multiplier doubles each time. (e.g., Level 7 is 4.2 + (1.6 * 2) = 7.4x)
            - The final damage should be the weapon's damage stat multiplied by this skill level multiplier, rounded to the nearest whole number.
            - When enemies attack the player, reduce the damage taken by the player's armor's damage reduction stat.
            - Describe what happens in the combat log. Be descriptive and reflect the power of high-level attacks.
            - Calculate HP changes for the player and all enemies.
            - Provide a new list of 3-4 available actions for the player's next turn.
            - IMPORTANT: Determine if the combat is over ONLY if the player is defeated. Do NOT set combatOver to true if only the enemies are defeated; the game client will handle that check.
        `;

        const response = await callGemini(
            "gemini-2.5-flash",
            initialPrompt,
            {
                responseMimeType: "application/json",
                responseSchema: combatActionSchema,
                safetySettings: safetySettings,
            },
        );

        let data;
        if (response.text && typeof response.text === 'string') {
            data = JSON.parse(response.text).combatResult;
        } else {
            data = JSON.parse(response.candidates[0].content.parts[0].text).combatResult;
        }

        const newEnemies = [...gameState.combat.enemies];
        data.enemyHpChanges.forEach((change: { id: string, hpChange: number }) => {
            const enemyIndex = newEnemies.findIndex(e => e.id === change.id);
            if (enemyIndex !== -1) {
                newEnemies[enemyIndex].hp += change.hpChange;
            }
        });

        const newPlayerHp = gameState.character.hp + data.playerHpChange;
        if (newPlayerHp <= 0) {
            setGameState(prevState => ({ ...prevState, character: { ...prevState.character, hp: 0 }, gameStatus: 'gameOver' }));
            return;
        }

        const allEnemiesDefeated = newEnemies.every(e => e.hp <= 0);

        if (allEnemiesDefeated) {
            const victoryPrompt = `
                The player, ${gameState.character.name}, has just won a battle.
                The combat is over. Generate a JSON object using the 'combatResult' schema with the following properties:
                - "combatOver": true
                - "victoryText": A short, epic description of the victory.
                - "xpGained": A reasonable amount of XP for the win.
                - "loot": An object containing "gold" and a list of "items" the player found.
                - Set "log", "playerHpChange", "enemyHpChanges", and "availableActions" to empty or placeholder values (e.g., [], 0).
            `;
            const victoryResponse = await callGemini(
                "gemini-2.5-flash",
                victoryPrompt,
                { responseMimeType: "application/json", responseSchema: combatActionSchema, safetySettings: safetySettings }
            );

            let victoryData;
            if (victoryResponse.text && typeof victoryResponse.text === 'string') {
                victoryData = JSON.parse(victoryResponse.text).combatResult;
            } else {
                victoryData = JSON.parse(victoryResponse.candidates[0].content.parts[0].text).combatResult;
            }
            const victoryIllustration = await generateImage(`${gameState.storyGuidance.setting}. ${victoryData.victoryText}`);
            const victorySegment: StorySegment = { text: victoryData.victoryText || "You are victorious!", illustration: victoryIllustration };

            setGameState(prevState => {
                if (!prevState.character) return prevState;
                const newXp = prevState.character.xp + (victoryData.xpGained || 0);
                const earnedSkillPoints = Math.floor(newXp / 100) - Math.floor(prevState.character.xp / 100);
                const newLoot = victoryData.loot || { gold: 0, items: [] };
                return {
                    ...prevState,
                    character: {
                        ...prevState.character,
                        hp: newPlayerHp,
                        xp: newXp,
                        skillPoints: prevState.character.skillPoints + earnedSkillPoints,
                        gold: prevState.character.gold + newLoot.gold,
                        equipment: { ...prevState.character.equipment, gear: [...(prevState.character.equipment.gear || []), ...newLoot.items] },
                    },
                    gameStatus: 'looting',
                    combat: null,
                    loot: newLoot,
                    storyLog: [...prevState.storyLog, victorySegment]
                };
            });
        } else {
            setGameState(prevState => {
                if (!prevState.character || !prevState.combat) return prevState;
                const newLog: CombatLogEntry[] = data.log.map((message: string) => ({ type: 'info', message }));
                return {
                    ...prevState,
                    character: { ...prevState.character, hp: newPlayerHp },
                    combat: { ...prevState.combat, enemies: newEnemies, log: [...prevState.combat.log, ...newLog], availableActions: data.availableActions || ['Attack', 'Defend', 'Use Skill'] },
                };
            });
        }
    } catch (error) {
        console.error("Combat action failed:", error);
    } finally {
        setApiIsLoading(false);
    }
}, [gameState, generateImage, apiIsLoading]);

  const handleSyncMap = useCallback(async () => {
    if (!gameState.character || !gameState.storyGuidance || !gameState.storyLog) return;
    setApiIsLoading(true);

    try {
        const storyHistory = gameState.storyLog.map(s => s.text).join('\n\n');
        const prompt = `
            Based on the following story, generate a list of 5-7 key locations.
            These locations should be a mix of places the player has visited and places that have been mentioned but not yet explored.
            For each location, provide a name, a brief description, and x/y coordinates for a map.

            Story:
            ${storyHistory}
        `;

        const response = await callGemini(
            "gemini-2.5-flash",
            prompt,
            {
                responseMimeType: "application/json",
                responseSchema: mapGenSchema,
                safetySettings: safetySettings,
            }
        );

        let data;
        if (response.text && typeof response.text === 'string') {
            data = JSON.parse(response.text);
        } else {
            data = JSON.parse(response.candidates[0].content.parts[0].text);
        }
        const mapImage = await generateImage(`A fantasy world map for a story about ${gameState.storyGuidance.plot}.`);

        const newLocations: MapLocation[] = data.locations.map((loc: any) => ({
            ...loc,
            visited: gameState.storyLog.some(segment => segment.text.includes(loc.name))
        }));

        setGameState(prevState => ({
            ...prevState,
            map: {
                backgroundImage: mapImage,
                locations: newLocations
            }
        }));

    } catch (error) {
        console.error("Map sync failed:", error);
    } finally {
        setApiIsLoading(false);
    }
  }, [gameState, generateImage]);

  const handleSyncAlignment = useCallback(async () => {
    if (!gameState.character || !gameState.storyLog || gameState.storyLog.length === 0) {
        console.log("Not enough story history to sync alignment.");
        return;
    }
    setApiIsLoading(true);
    console.log("Syncing alignment based on story history...");

    try {
        const storyHistory = gameState.storyLog.map(s => s.text).join('\n\n');
        const companionNames = gameState.companions.map(c => c.name).join(', ');

        const prompt = `
            Analyze the following story from a text adventure game. Based on the actions and events, determine the alignment of the main character (${gameState.character.name}) and their companions (${companionNames}).
            Return the alignment scores on a scale of -100 (Chaotic/Evil) to 100 (Lawful/Good).

            - A lawful character follows rules, traditions, or a personal code. A chaotic character follows their whims, valuing freedom over order.
            - A good character protects the innocent and helps others. An evil character is willing to harm, oppress, or kill others for their own gain.

            Story:
            ---
            ${storyHistory}
            ---
        `;

        const response = await callGemini(
            "gemini-2.5-flash",
            prompt,
            {
                responseMimeType: "application/json",
                responseSchema: alignmentSyncSchema,
                safetySettings: safetySettings,
            }
        );

        let data;
        if (response.text && typeof response.text === 'string') {
            data = JSON.parse(response.text);
        } else {
            data = JSON.parse(response.candidates[0].content.parts[0].text);
        }

        setGameState(prevState => {
            if (!prevState.character) return prevState;

            const updatedCompanions = prevState.companions.map(comp => {
                const syncedComp = data.companionAlignments.find((sc: any) => sc.name === comp.name);
                return syncedComp
                    ? { ...comp, alignment: { lawfulness: syncedComp.lawfulness, goodness: syncedComp.goodness } }
                    : comp;
            });

            return {
                ...prevState,
                character: {
                    ...prevState.character,
                    alignment: data.playerAlignment
                },
                companions: updatedCompanions
            };
        });

        console.log("Alignment sync complete!");

    } catch (error) {
        console.error("Alignment sync failed:", error);
    } finally {
        setApiIsLoading(false);
    }
  }, [gameState]);

  const handleSyncHp = () => {
        setGameState(g => {
            if (!g.character || g.character.name !== "Cinderblaze") return g;

            let totalHp = 100;
            for (let level = 2; level <= 16; level++) {
                const diceRolls = Array.from({ length: 3 }, () => Math.floor(Math.random() * 6) + 1);
                const hpGain = diceRolls.reduce((a, b) => a + b, 0) + level;
                totalHp += hpGain;
            }

            return {
                ...g,
                character: {
                    ...g.character,
                    maxHp: totalHp,
                    hp: totalHp,
                }
            };
        });
    };

  const handleSyncGoldAndLoot = () => {
    setGameState(g => {
        if (!g.character || g.character.name !== "Cinderblaze") return g;

        const syncGold = Math.floor(Math.random() * 10000) + 1;

        const syncedItems: Equipment[] = [
            {
                name: "Amulet of the Ages",
                description: "A powerful amulet that hums with ancient energy.",
                stats: { damageReduction: 5 },
                value: 5000
            },
            {
                name: "Ring of the Phoenix",
                description: "A ring that seems to burn with an inner fire.",
                stats: { damage: 5 },
                value: 5000
            }
        ];

        return {
            ...g,
            character: {
                ...g.character,
                gold: g.character.gold + syncGold,
                equipment: {
                    ...g.character.equipment,
                    gear: [...(g.character.equipment.gear || []), ...syncedItems],
                },
            }
        };
    });
  };

  const handleUpdateGold = (amount: number) => {
    setGameState(prev => {
        if (!prev.character) return prev;
        return {
            ...prev,
            character: { ...prev.character, gold: prev.character.gold + amount }
        };
    });
  };

  const handleAddGamblingItem = (item: Equipment) => {
    setGameState(prev => {
        if (!prev.character) return prev;
        return {
            ...prev,
            character: { 
                ...prev.character, 
                equipment: {
                    ...prev.character.equipment,
                    gear: [...(prev.character.equipment.gear || []), item]
                }
            }
        };
    });
  };

  const handleLootContinue = () => {
    handleAction("What happens now?");
    setGameState(prevState => ({
        ...prevState,
        gameStatus: 'playing',
        loot: null,
    }));
  };

  const handleTransaction = (item: Equipment, action: 'buy' | 'sell') => {
    setGameState(prevState => {
        if (!prevState.character) return prevState;

        let newGold = prevState.character.gold;
        let newGear = [...(prevState.character.equipment.gear || [])];

        if (action === 'buy') {
            newGold -= item.value;
            newGear.push(item);
        } else {
            newGold += Math.floor(item.value / 2);
            newGear = newGear.filter(i => i.name !== item.name);
        }

        return {
            ...prevState,
            character: {
                ...prevState.character,
                gold: newGold,
                equipment: {
                    ...prevState.character.equipment,
                    gear: newGear,
                },
            },
        };
    });
  };

  const handleTransactionExit = () => {
    setGameState(prevState => ({
        ...prevState,
        gameStatus: 'playing',
        transaction: null,
    }));
  };

  // Update signature to accept new stats
  const handleLevelUpComplete = (updatedSkills: {[key: string]: number}, updatedStats: CharacterStats) => {
      setGameState(g => {
        if (!g.character) return g;

        // 1. Calculate Stat Differences (to confirm points spent)
        // (Assuming strict validation isn't needed for this demo, we trust the UI)

        // 2. HP Gain Logic (CON effect)
        // "con which increases hp bonus at level up"
        const diceRolls = Array.from({ length: 3 }, () => Math.floor(Math.random() * 6) + 1);
        const baseHpGain = diceRolls.reduce((a, b) => a + b, 0) + 1; // Base +1 for level
        const conBonus = Math.floor(updatedStats.con); // Simple 1-to-1 or threshold? User said "increases hp bonus".
        const totalHpGain = Math.max(1, baseHpGain + conBonus); 

        const newMaxHp = g.character.maxHp + totalHpGain;

        // 3. Skill Point Logic (INT effect)
        // "int which increases the amount of skill points you get by 1 every 4 level ups"
        // Interpreting: You get 1 base point + (INT / 4) extra points per level up.
        const intBonus = Math.floor(updatedStats.int / 4);
        const skillPointsGained = 1 + intBonus;

        return {
            ...g,
            character: {
                ...g.character,
                skills: updatedSkills,
                stats: updatedStats, // Update stats
                skillPoints: (g.character.skillPoints - /* spent on skills */ 0) + skillPointsGained, // Simplified: reset logic handled in allocator
                maxHp: newMaxHp,
                hp: newMaxHp, // Heal on level up?
            },
            gameStatus: 'playing'
        }
      });
  };

  const handleActionWrapper = async (action: string) => {
        if (isMultiplayer && lobbyId && lobbyData) {
            const currentPlayerIndex = lobbyData.currentTurnIndex % lobbyData.players.length;
            const currentPlayer = lobbyData.players[currentPlayerIndex];

            if (currentPlayer.uid !== user?.uid) {
                alert(`It is ${currentPlayer.displayName}'s turn!`);
                return;
            }

            const nextTurnIndex = lobbyData.currentTurnIndex + 1;
            await updateDoc(doc(db, "lobbies", lobbyId), {
                currentTurnIndex: nextTurnIndex
            });
        }
        
        await handleAction(action);
  };

  const getAlignmentDescriptor = (alignment: Alignment): string => {
        const { lawfulness, goodness } = alignment;
        let descriptor = "";

        if (goodness > 33) descriptor += "Good";
        else if (goodness < -33) descriptor += "Evil";
        else descriptor += "Neutral";

        if (lawfulness > 33) descriptor = "Lawful " + descriptor;
        else if (lawfulness < -33) descriptor = "Chaotic " + descriptor;

        return descriptor.trim();
  };

  // 4. EFFECTS (Moved UP)
  useEffect(() => {
      const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
          setUser(currentUser);
          if (currentUser) {
              // --- FIX: Show loading immediately while fetching ---
              setView('loading'); 
              await fetchSavedGames(currentUser.uid);
          } else {
              // --- FIX: Go to landing page when logged out ---
              setView('landing');
          }
      });
      return () => unsubscribe();
  }, []);

  // 1. ADD THIS NEW FUNCTION
  const handleJoinLobby = async (idToJoin: string) => {
      if (!user || !idToJoin) return;
      const cleanId = idToJoin.trim();
      
      try {
          const lobbyRef = doc(db, "lobbies", cleanId);
          const lobbySnap = await getDoc(lobbyRef);
          
          if (!lobbySnap.exists()) {
              alert("Lobby not found!");
              return;
          }

          // Add player to list if not already there
          const lobbyData = lobbySnap.data();
          const playerExists = lobbyData.players.some((p: Player) => p.uid === user.uid);
          
          if (!playerExists) {
              await updateDoc(lobbyRef, {
                  players: arrayUnion({
                      uid: user.uid,
                      displayName: user.displayName || "Adventurer",
                      isHost: false,
                      isReady: true
                  })
              });
          }
          
          setLobbyId(cleanId);
          setIsMultiplayer(true);
      } catch (error) {
          console.error("Error joining lobby:", error);
          alert("Failed to join lobby.");
      }
  };

  // 2. UPDATE THIS USEEFFECT (Fixes the "Empty ID" bug)
  useEffect(() => {
      if (!lobbyId) return;
      const unsub = onSnapshot(doc(db, "lobbies", lobbyId), (docSnap) => {
          if (docSnap.exists()) {
              const data = docSnap.data();
              // --- FIX: Explicitly merge the doc ID into the data object ---
              setLobbyData({ id: docSnap.id, ...data } as MultiplayerLobby);
              
              // Sync Game State from Lobby
              if (data.gameState) {
                  setGameState(data.gameState);
              }
              
              // Transition logic
              if (data.status === 'playing' && gameState.gameStatus === 'initial_load') {
                  setGameState(prev => ({ ...prev, gameStatus: 'playing' }));
                  setView('game'); // Switch view to game
              } else if (data.status === 'setup' && view !== 'creation' && view !== 'loading') {
                  // If host is setting up, guests wait
                  if (data.hostUid !== user?.uid) {
                      setView('loading'); // Reuse loading view for "Waiting for Host..."
                  }
              }
          }
      });
      return () => unsub();
  }, [lobbyId, user?.uid]);

  useEffect(() => {
      if (gameState.gameStatus !== 'initial_load' && gameState.gameStatus !== 'loading' && user && activeCharacterId) {
          const timeoutId = setTimeout(() => saveGameToCloud(gameState), 1000);
          return () => clearTimeout(timeoutId);
      }
  }, [gameState, user, activeCharacterId, isMultiplayer, lobbyId]);

   useEffect(() => {
    const handleForceActions = () => {
      console.log("Force combat actions command received.");
      setGameState(prevState => {
        if (prevState.gameStatus === 'combat' && prevState.combat) {
          return {
            ...prevState,
            combat: {
              ...prevState.combat,
              availableActions: ['Attack', 'Defend', 'Use Skill'],
            },
          };
        }
        return prevState;
      });
    };

    window.addEventListener('force-combat-actions', handleForceActions);
    (window as any).syncMap = handleSyncMap;
    (window as any).syncAlignment = handleSyncAlignment; 

    return () => {
      window.removeEventListener('force-combat-actions', handleForceActions);
    };
  }, [handleSyncMap, handleSyncAlignment]);

  // Update the RENDER SWITCH in App component:
  if (!user) {
      // Show Landing Page if not logged in
      return <LandingPage onPlayNow={handleLogin} />;
  }

  if (view === 'loading') return <Loader text="Loading archives..." />;

  if (view === 'menu') {
      return <MainMenuScreen 
          onNewGame={handleStartCreation} 
          onLoadGame={() => setView('load_menu')} // New view state for character list
          onMultiplayer={() => setView('lobby')}
          onExit={() => auth.signOut()} 
      />;
  }
  
  if (view === 'load_menu') {
      return (
          <CharacterSelect 
              saves={savedGames}
              onSelect={handleCharacterSelect}
              onNew={handleStartCreation}
              onDelete={handleDeleteCharacter}
              onLogout={() => auth.signOut()}
              onBack={() => setView('menu')}
          />
      );
  }

  // --- EXISTING CHARACTER SELECT (Now used for Load Game) ---
  if (view === 'load_game') {
      return (
          <CharacterSelect 
              saves={savedGames}
              onSelect={handleCharacterSelect}
              onNew={handleStartCreation}
              onDelete={handleDeleteCharacter}
              onLogout={() => auth.signOut()}
              onBack={() => setView('menu')} // Add a back button to CharacterSelect
          />
      );
  }

  if (view === 'creation') {
      if (gameState.gameStatus === 'characterCreation') {
          return (
            <div>
                <button onClick={handleBackToMenu} style={{position: 'absolute', top: '1rem', left: '1rem', zIndex: 100}}>Back</button>
                <CharacterCreationScreen onCreate={handleCreateCharacter} isLoading={apiIsLoading} />
            </div>
          );
      } else if (gameState.gameStatus === 'characterCustomize') {
          return <SkillAllocator 
                    title="Customize" 
                    skillPools={creationData!.skillPools} 
                    availablePoints={creationData!.startingSkillPoints} 
                    onComplete={handleFinalizeCharacter} 
                    completeButtonText="Finalize" 
                 />;
      }
  }

  if (view === 'lobby') {
      if (!lobbyId) {
          return <LobbyBrowser 
                    // --- FIX IS HERE: Change 'game' to 'load_menu' ---
                    onSinglePlayer={() => { setIsMultiplayer(false); setView('load_menu'); }} 
                    // -------------------------------------------------
                    onCreate={handleCreateLobby} 
                    onJoin={handleJoinLobby} 
                    onBack={() => setView('menu')}
                 />;
      }
      if (!lobbyData) return <Loader text="Connecting..." />;

      // 3a. If Host clicked "Start Adventure", show Character Select
      if (showLobbySelect) {
          return <CharacterSelect 
              saves={savedGames}
              onSelect={handleLobbyCharacterSelect} // Use the new handler
              onNew={async () => { 
                  // If creating NEW, update status to 'setup' so guests wait
                  await updateDoc(doc(db, "lobbies", lobbyId), { status: 'setup' });
                  setShowLobbySelect(false); 
                  handleStartCreation(); 
              }}
              onDelete={handleDeleteCharacter}
              onLogout={() => auth.signOut()}
              onBack={() => setShowLobbySelect(false)} // Allow cancelling back to waiting room
          />;
      }
      
      // 3b. Otherwise show Waiting Room
      return <WaitingRoom 
          lobby={lobbyData} 
          onStart={() => setShowLobbySelect(true)} 
          onLeave={handleBackToMenu} // Pass the back function here
      />;
  }

  // Game View
  const isMyTurn = !isMultiplayer || (!!lobbyData && !!user && lobbyData.players[lobbyData.currentTurnIndex % lobbyData.players.length]?.uid === user.uid);
  
  return (
    <div id="app-container">
        {isMultiplayer && <div className="turn-indicator">Multiplayer | {lobbyId}</div>}
        {renderContent(gameState)}
        
        <CustomActionModal 
            isOpen={isCustomActionModalOpen} 
            onClose={() => setIsCustomActionModalOpen(false)} 
            onSubmit={(a) => { setIsCustomActionModalOpen(false); handleAction(a); }} 
            isLoading={apiIsLoading} 
        />
    </div>
  );

  function renderContent(currentGameState: GameState) {
      switch (currentGameState.gameStatus) {
          case 'playing': return <GameScreen gameState={currentGameState} onAction={handleAction} onBackToMenu={handleBackToMenu} onLevelUp={() => setGameState(g => ({...g, gameStatus: 'levelUp'}))} isLoading={apiIsLoading} onCustomActionClick={() => setIsCustomActionModalOpen(true)} getAlignmentDescriptor={getAlignmentDescriptor} onOpenGambling={() => setGameState(g => ({...g, gameStatus: 'gambling'}))} isMyTurn={isMyTurn} />;
          case 'combat': return <CombatScreen gameState={currentGameState} onCombatAction={handleCombatAction} isLoading={apiIsLoading} onBackToMenu={handleBackToMenu} />;
          case 'levelUp': return <SkillAllocator title="Level Up" skillPools={currentGameState.skillPools!} availablePoints={currentGameState.character!.skillPoints} initialSkills={currentGameState.character!.skills} onComplete={handleLevelUpComplete} completeButtonText="Confirm" onCancel={() => setGameState(g => ({...g, gameStatus: 'playing'}))} />;
          case 'gambling': return <GamblingScreen gameState={currentGameState} onExit={() => setGameState(g => ({...g, gameStatus: 'playing'}))} onUpdateGold={(amt) => setGameState(p => ({...p, character: {...p.character!, gold: p.character!.gold + amt}}))} onAddItem={(itm) => setGameState(p => ({...p, character: {...p.character!, equipment: {...p.character!.equipment, gear: [...(p.character!.equipment.gear||[]), itm]}}}))} isLoading={apiIsLoading} setIsLoading={setApiIsLoading} />;
          case 'looting': return <LootScreen loot={currentGameState.loot!} onContinue={() => { setGameState(p => ({...p, gameStatus:'playing', loot:null})); handleAction("Continue story"); }} />;
          case 'transaction': return <TransactionScreen gameState={currentGameState} onExit={() => setGameState(p => ({...p, gameStatus:'playing', transaction:null}))} onTransaction={(item, type) => { setGameState(p => { const gold = type === 'buy' ? p.character!.gold - item.value : p.character!.gold + Math.floor(item.value/2); return {...p, character: {...p.character!, gold }}}) }} />;
          case 'gameOver': return <GameOverScreen onNewGame={() => setView('menu')} />;
          default: return <Loader text="Loading..." />;
      }
  }
};

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<React.StrictMode><App /></React.StrictMode>);
}