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
  doc, 
  setDoc, 
  getDoc, 
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
const db = getFirestore(app);
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
interface Character {
  name: string;
  gender: string;
  hp: number;
  maxHp: number;
  xp: number;
  skills: { [key: string]: number };
  skillPoints: number;
  description: string;
  portrait: string | null; // base64 image
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

type SkillPools = { [key: string]: string[] };

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
  gameStatus: 'characterCreation' | 'characterCustomize' | 'levelUp' | 'playing' | 'loading' | 'initial_load' | 'combat' | 'gameOver' | 'looting' | 'transaction';
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
    startingMap: {
        locations: Omit<MapLocation, 'visited'>[];
        startingLocationName: string;
    };
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
        description: "Three pools of skills for the player to choose from, categorized as 'Combat', 'Magic', and 'Utility'. Each pool should contain 4-5 unique skills.",
        properties: {
            Combat: { type: Type.ARRAY, items: { type: Type.STRING } },
            Magic: { type: Type.ARRAY, items: { type: Type.STRING } },
            Utility: { type: Type.ARRAY, items: { type: Type.STRING } },
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
  const [campaign, setCampaign] = useState(CAMPAIGN_TYPES[0]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      onCreate({ name: name.trim(), gender, race, characterClass, background, campaign });
    }
  };

  return (
    <div className="creation-container">
      <video 
        className="welcome-video" 
        src="/ea-video.mp4" 
        autoPlay 
        loop 
        muted 
        playsInline 
      />
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

const GameScreen = ({ gameState, onAction, onNewGame, onLevelUp, isLoading, onCustomActionClick, onSyncHp, onSyncGoldAndLoot, onSyncMap, getAlignmentDescriptor, onOpenGambling, isMyTurn }: { gameState: GameState, onAction: (action: string) => void, onNewGame: () => void, onLevelUp: () => void, isLoading: boolean, onCustomActionClick: () => void, onSyncHp: () => void, onSyncGoldAndLoot: () => void, onSyncMap: () => void, getAlignmentDescriptor: (alignment: Alignment) => string, onOpenGambling: () => void, isMyTurn: boolean }) => {
    const [isSpeaking, setIsSpeaking] = useState(false);

    if (!gameState.character || gameState.storyLog.length === 0) {
        return <Loader text="Loading game..." />;
    }

    const { character, storyLog, currentActions, map } = gameState;
    const currentScene = storyLog[storyLog.length - 1];

    useEffect(() => {
        // Ensure voices are loaded. This is sometimes necessary for browsers.
        speechSynthesis.onvoiceschanged = () => {};
        // When the scene changes or component unmounts, stop any ongoing speech.
        return () => {
            if (speechSynthesis.speaking) {
                speechSynthesis.cancel();
                setIsSpeaking(false);
            }
        };
    }, [currentScene]);


    const handlePlayAudio = (text: string, gender: string) => {
        if (speechSynthesis.speaking) {
            speechSynthesis.cancel();
            setIsSpeaking(false);
            return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        const voices = speechSynthesis.getVoices();
        let selectedVoice = null;

        if (gender === 'Male') {
            selectedVoice = voices.find(v => v.lang.startsWith('en') && v.name.includes('Male')) || voices.find(v => v.lang.startsWith('en'));
        } else { // Female
            selectedVoice = voices.find(v => v.lang.startsWith('en') && v.name.includes('Female')) || voices.find(v => v.lang.startsWith('en'));
        }

        if (selectedVoice) {
            utterance.voice = selectedVoice;
        }

        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => setIsSpeaking(false);
        utterance.onerror = () => setIsSpeaking(false);

        speechSynthesis.speak(utterance);
    };

    const handleLocationClick = (locationName: string) => {
        onAction(`Travel to ${locationName}`);
    };

    return (
        <div className="game-container">
            <header className="game-header">
                <h1><img src="/ea-logo.png" />&nbsp;Endless Adventure</h1>
                <div>
                    {/* [ADD THIS BUTTON] */}
                    <button onClick={onOpenGambling} style={{marginRight: '1rem', borderColor: '#f1c40f', color: '#f1c40f'}}>🎲 Casino</button>
                    <button onClick={onNewGame} className="new-game-btn">Start New Game</button>
                </div>
            </header>
            <main className="game-main">
                <div className="character-panel">
                    {character.portrait ? (
                        <img src={character.portrait} alt={`${character.name}'s portrait`} className="character-portrait" />
                    ) : (
                        <div className="character-portrait-placeholder" /> 
                    )}
                    <h2>{character.name}</h2>
                    {character.alignment && (
                        <div className="alignment-display">
                            <div className="alignment-grid">
                                <div className="alignment-marker" style={{ 
                                    left: `${50 + character.alignment.lawfulness / 2}%`, 
                                    top: `${50 - character.alignment.goodness / 2}%` 
                                }}></div>
                            </div>
                            <span className="alignment-label">{getAlignmentDescriptor(character.alignment)}</span>
                        </div>
                    )}
                    <div className="stats-grid">
                        <div className="stat-item">
                            <span className="stat-label">HP</span>
                            <span className="stat-value">{character.hp}</span>
                        </div>
                         <div className="stat-item">
                            <span className="stat-label">XP</span>
                            <span className="stat-value">{character.xp}</span>
                        </div>
                        <div className="stat-item full-width">
                            <span className="stat-label">Gold</span>
                            <span className="stat-value">{character.gold}</span>
                        </div>
                    </div>

                    {character.skillPoints > 0 && (
                        <button onClick={onLevelUp} className="level-up-btn">
                            Level Up ({character.skillPoints} Points)
                        </button>
                    )}

                    {/* --- DEBUG BUTTONS ---
                    {character.name === "Cinderblaze" && (
                        <>
                            <button onClick={onSyncHp} className="level-up-btn" style={{backgroundColor: '#4a90e2', animation: 'none', marginBottom: '0.5rem'}}>
                                Sync HP to Level 16
                            </button>
                            <button onClick={onSyncGoldAndLoot} className="level-up-btn" style={{backgroundColor: '#f39c12', animation: 'none', marginBottom: '0.5rem'}}>
                                Sync Gold & Loot
                            </button>
                            <button onClick={onSyncMap} className="level-up-btn" style={{backgroundColor: '#9b59b6', animation: 'none', marginBottom: '1.5rem'}}>
                                Sync Map
                            </button>
                        </>
                    )}
                     --- END DEBUG BUTTONS --- */}


                    <h3>Skills</h3>
                    <ul className="skills-list">
                        {Object.entries(character.skills).sort(([, lvlA], [, lvlB]) => lvlB - lvlA).map(([skill, level]) => (
                            <li key={skill}>{skill} <span className="skill-level">Lvl {level}</span></li>
                        ))}
                    </ul>

                    {character.equipment && ( // <-- Add this check here
                      <>
                        <h3>Equipment</h3>
                        <ul className="skills-list">
                          <li>
                            🗡️Weapon: {character.equipment.weapon?.name} <span className="skill-level">DMG: {character.equipment.weapon?.stats.damage}</span>
                          </li>
                          <li>
                            🛡️Armor: {character.equipment.armor?.name} <span className="skill-level">DR: {character.equipment.armor?.stats.damageReduction}</span>
                          </li>
                          {character.equipment.gear && character.equipment.gear.map((gear, index) => (
                            <li key={`${gear.name}-${index}`}>
                              {gear.name}
                              <span className="skill-level">
                                {gear.stats.damage ? `DMG: ${gear.stats.damage}` : ''}
                                {gear.stats.damage && gear.stats.damageReduction ? ' | ' : ''}
                                {gear.stats.damageReduction ? `DR: ${gear.stats.damageReduction}` : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}


                    <h3>Party</h3>
                    <ul className="skills-list">
                        {gameState.companions && gameState.companions.length > 0 ? (
                            gameState.companions.map(companion => (
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
                <div className="game-content-area">
                    <div className="story-panel">
                        <div className="illustration-container">
                           {isLoading && <div className="illustration-loader"><Loader text="Drawing next scene..."/></div>}
                           {currentScene.illustration ? (
                               <img src={currentScene.illustration} alt="Current scene" className={`story-illustration ${isLoading ? 'loading' : ''}`} />
                           ) : null}
                        </div>
                        <div className="story-text">
                            <button
                                className="play-audio-btn"
                                onClick={() => handlePlayAudio(currentScene.text, character.gender)}
                                aria-label={isSpeaking ? 'Stop narration' : 'Play narration'}
                            >
                                {isSpeaking ? '⏹️' : '▶️'}
                            </button>
                            {/* Display skill check result here */}
                            {currentScene.skillCheck && (
                                <p style={{
                                    fontStyle: 'italic',
                                    color: currentScene.skillCheck.success ? '#2ecc71' : '#e74c3c',
                                    textAlign: 'center',
                                    border: `1px solid ${currentScene.skillCheck.success ? '#2ecc71' : '#e74c3c'}`,
                                    padding: '0.5rem',
                                    borderRadius: 'var(--border-radius)',
                                    marginBottom: '1rem',
                                    backgroundColor: 'rgba(0,0,0,0.2)'
                                }}>
                                    Your <b>{currentScene.skillCheck.skillName}</b> check ({currentScene.skillCheck.difficulty}) was a <b style={{textTransform: 'uppercase'}}>{currentScene.skillCheck.success ? 'success' : 'failure'}</b>!
                                </p>
                            )}
                            <p>{currentScene.text}</p>
                        </div>
                        <div className="actions-panel">
                            {currentActions.map(action => (
                                <button 
                                    key={action} 
                                    onClick={() => onAction(action)} 
                                    disabled={isLoading || !isMyTurn} // <--- Disable if not my turn
                                    style={{ opacity: isMyTurn ? 1 : 0.5 }} // Visual cue
                                >
                                    {action}
                                </button>
                            ))}
                            <button onClick={onCustomActionClick} disabled={isLoading || !isMyTurn} style={{ opacity: isMyTurn ? 1 : 0.5 }} className="custom-action-btn">
                                Custom Action...
                            </button>
                        </div>
                    </div>
                    <MapPanel mapState={map} onLocationClick={handleLocationClick} isLoading={isLoading} />
                </div>
            </main>
        </div>
    );
}

const CombatScreen = ({ gameState, onCombatAction, isLoading, onSyncHp }: { gameState: GameState, onCombatAction: (action: string) => void, isLoading: boolean, onSyncHp: () => void }) => {
    const [isSpeaking, setIsSpeaking] = useState(false);

    if (!gameState.character || !gameState.combat) {
        return <Loader text="Loading combat..." />;
    }

    const { character, combat } = gameState;

    useEffect(() => {
        speechSynthesis.onvoiceschanged = () => {};
        return () => {
            if (speechSynthesis.speaking) {
                speechSynthesis.cancel();
                setIsSpeaking(false);
            }
        };
    }, []);

    const handlePlayAudio = (text: string, gender: string) => {
        if (speechSynthesis.speaking) {
            speechSynthesis.cancel();
            setIsSpeaking(false);
            return;
        }
        const utterance = new SpeechSynthesisUtterance(text);
        const voices = speechSynthesis.getVoices();
        let selectedVoice = voices.find(v => v.lang.startsWith('en') && v.name.includes(gender)) || voices.find(v => v.lang.startsWith('en'));

        if (selectedVoice) {
            utterance.voice = selectedVoice;
        }
        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => setIsSpeaking(false);
        utterance.onerror = () => setIsSpeaking(false);
        speechSynthesis.speak(utterance);
    };

    return (
        <div className="combat-container">
            <header className="combat-header">
                <h1>Combat!</h1>
            </header>
            <div className="combat-participants-container">
                <div className="player-card">
                    <img src={character.portrait || ''} alt={character.name} className="character-portrait-combat" />
                    <h3>{character.name}</h3>
                    <div className="player-hp-bar-container">
                        <div className="player-hp-bar" style={{ width: `${(character.hp / character.maxHp) * 100}%` }}></div>
                    </div>
                    <span>HP: {character.hp} / {character.maxHp}</span>

                    {/* --- DEBUG BUTTON ---
                    {character.name === "Cinderblaze" && (
                        <button onClick={onSyncHp} className="level-up-btn" style={{backgroundColor: '#4a90e2', marginTop: '1rem'}}>
                            Sync HP to Level 16
                        </button>
                    )}
                     --- END DEBUG BUTTON --- */}
                </div>
                <div className="enemies-container">
                    {combat.enemies.map(enemy => (
                        <div key={enemy.id} className={`enemy-card ${enemy.hp <= 0 ? 'defeated' : ''}`}>
                            <img src={enemy.portrait || ''} alt={enemy.name} className="enemy-portrait" />
                            <h3>{enemy.name}</h3>
                            <div className="enemy-hp-bar-container">
                                <div className="enemy-hp-bar" style={{ width: `${(enemy.hp / enemy.maxHp) * 100}%` }}></div>
                            </div>
                            <span>HP: {enemy.hp} / {enemy.maxHp}</span>
                        </div>
                    ))}
                </div>
            </div>
            <div className="combat-log-container">
                {combat.log.map((entry, index) => (
                    <div key={index} className={`combat-log-entry ${entry.type}`}>
                        {/* Add this condition to render the button for the first 'info' entry */}
                        {index === 0 && entry.type === 'info' && (
                            <button
                                className="play-audio-btn"
                                onClick={() => handlePlayAudio(entry.message, character.gender)}
                                aria-label={isSpeaking ? 'Stop narration' : 'Play narration'}
                                style={{ float: 'right', marginLeft: '1rem' }} // Basic positioning
                            >
                                {isSpeaking ? '⏹️' : '▶️'}
                            </button>
                        )}
                        {entry.message}
                    </div>
                )).reverse()}
            </div>
            <div className="combat-actions-panel">
                {combat.availableActions.map(action => (
                    <button key={action} onClick={() => onCombatAction(action)} disabled={isLoading}>
                        {action}
                    </button>
                ))}
            </div>
        </div>
    );
};

const LootScreen = ({ loot, onContinue }: { loot: Loot, onContinue: () => void }) => {
    return (
        <div className="loot-container">
            <h1>Victory!</h1>
            <p className="loot-summary">You found {loot.gold} gold!</p>
            {loot.items.length > 0 && (
                <>
                    <h3>Items Found:</h3>
                    <ul className="loot-items">
                        {loot.items.map(item => (
                            <li key={item.name} className="loot-item">
                                <strong>{item.name}</strong> - <em>{item.value} gold</em>
                                <p>{item.description}</p>
                            </li>
                        ))}
                    </ul>
                </>
            )}
            <button onClick={onContinue}>Continue</button>
        </div>
    );
};

const TransactionScreen = ({ gameState, onTransaction, onExit }: { gameState: GameState, onTransaction: (item: Equipment, action: 'buy' | 'sell') => void, onExit: () => void }) => {
    if (!gameState.character || !gameState.transaction) {
        return <Loader text="Loading transaction..." />;
    }
    const { character, transaction } = gameState;

    return (
        <div className="transaction-container">
            <div className="transaction-vendor-panel">
                <img src={transaction.vendorPortrait || ''} alt={transaction.vendorName} className="vendor-portrait" />
                <div>
                    <h1>{transaction.vendorName}</h1>
                    <p>{transaction.vendorDescription}</p>
                </div>
            </div>

            <h2>Vendor's Wares</h2>
            <ul className="transaction-items">
                {transaction.inventory.map(item => (
                    <li key={item.name} className="transaction-item">
                        <strong>{item.name}</strong> - <em>{item.value} gold</em>
                        <p>{item.description}</p>
                        <button onClick={() => onTransaction(item, 'buy')} disabled={character.gold < item.value}>Buy</button>
                    </li>
                ))}
            </ul>

            <h2>Your Inventory</h2>
            <ul className="transaction-items">
                {character.equipment.gear?.map(item => (
                     <li key={item.name} className="transaction-item">
                        <strong>{item.name}</strong> - <em>{Math.floor(item.value / 2)} gold</em>
                        <p>{item.description}</p>
                        <button onClick={() => onTransaction(item, 'sell')}>Sell</button>
                    </li>
                ))}
            </ul>

            <button onClick={onExit} className="cancel-btn">Leave</button>
        </div>
    );
};

const GameOverScreen = ({ onNewGame }: { onNewGame: () => void }) => (
    <div className="game-over-container">
        <h1>Game Over</h1>
        <p>Your adventure has come to an end.</p>
        <button onClick={onNewGame}>Start a New Journey</button>
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
                { responseMimeType: "application/json", responseSchema: riddleSchema }
            );
            const data = JSON.parse(response.candidates[0].content.parts[0].text);
            setRiddle(data);
            onUpdateGold(-bet); // Pay to play
            addLog(`Riddle: ${data.question}`, 'neutral');
        } catch (e) {
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
        onUpdateGold(-100); // Fixed cost

        try {
            const prompt = `
                Simulate a high-stakes rune casting game.
                The player pays 100 gold.
                - 50% chance to lose nothing (outcome: "nothing").
                - 30% chance to win gold (outcome: "win_gold", multiplier 1.5x to 5x).
                - 15% chance to lose more gold (outcome: "lose_gold").
                - 5% chance to win a RARE elite item (outcome: "win_item").
                Generate the result in JSON.
            `;
            const response = await callGemini(
                "gemini-2.5-flash", 
                prompt, 
                { responseMimeType: "application/json", responseSchema: runeSchema }
            );
            const data = JSON.parse(response.candidates[0].content.parts[0].text);

            addLog(data.narrative, 'neutral');

            if (data.outcome === 'win_gold') {
                const winnings = Math.floor(100 * data.multiplier);
                onUpdateGold(winnings);
                addLog(`Fortune smiles! You win ${winnings} gold.`, 'win');
            } else if (data.outcome === 'win_item' && data.item) {
                onAddItem(data.item);
                addLog(`AMAZING! You received: ${data.item.name}`, 'item');
            } else if (data.outcome === 'lose_gold') {
                // Already paid 100, maybe lose extra? Let's just say the 100 is gone.
                addLog(`The runes darken. Your tribute is consumed.`, 'lose');
            } else {
                addLog(`The runes are silent.`, 'neutral');
            }

        } catch (e) {
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
        <h1><img src="/ea-logo.png" style={{height: '3rem', verticalAlign: 'middle'}}/> Endless Adventure</h1>
        <p>Sign in to save your progress to the cloud and play with friends.</p>
        <button onClick={onLogin} className="google-btn">
            Sign in with Google
        </button>
    </div>
);

const LobbyBrowser = ({ 
    onJoin, 
    onCreate, 
    onSinglePlayer 
}: { 
    onJoin: (lobbyId: string) => void, 
    onCreate: () => void, 
    onSinglePlayer: () => void 
}) => {
    const [lobbies, setLobbies] = useState<any[]>([]);

    // In a real app, you'd use a Firestore query here to fetch 'waiting' lobbies
    // For now, we'll assume a simple create/single flow
    
    return (
        <div className="lobby-container">
            <h1>Campaign Selection</h1>
            <div className="lobby-list">
                <div className="lobby-item">
                    <div>
                        <h3>Single Player</h3>
                        <p>Embark on a solo journey.</p>
                    </div>
                    <button onClick={onSinglePlayer}>Play Solo</button>
                </div>
                
                <div className="lobby-item">
                    <div>
                        <h3>Multiplayer Campaign</h3>
                        <p>Create a room and invite adventurers.</p>
                    </div>
                    <button onClick={onCreate}>Create Room</button>
                </div>
                
                {/* List existing lobbies here if implementing a browser */}
            </div>
        </div>
    );
};

const WaitingRoom = ({ lobby, onStart }: { lobby: MultiplayerLobby, onStart: () => void }) => (
    <div className="lobby-container">
        <h2>Lobby: {lobby.name}</h2>
        <p>Share ID to join: <strong>{lobby.id}</strong></p>
        
        <div className="player-list">
            {lobby.players.map(p => (
                <div key={p.uid} className="player-chip">
                    {p.displayName} {p.isHost ? '👑' : ''}
                </div>
            ))}
        </div>

        {lobby.players.find(p => p.isHost)?.uid === auth.currentUser?.uid && (
            <button onClick={onStart} disabled={lobby.players.length < 1}>
                Start Adventure
            </button>
        )}
        <p className="skill-points-counter">Waiting for host to start...</p>
    </div>
);

// --- MAIN APP ---

const App = () => {
  // 1. ALL STATE DEFINITIONS FIRST
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

  // 2. REFS (Move this up from the bottom)
  const hasLoaded = useRef(false);

  // Add this inside App component
  const migrateLocalSaveToCloud = async (uid: string) => {
    const localSave = localStorage.getItem('endlessAdventureSave');
    if (!localSave) return; 

    try {
        console.log("Starting migration... extracting images...");
        const parsedSave = JSON.parse(localSave);
        let { gameState: localState, creationData: localCreation } = parsedSave;
        
        // 1. Upload Character Portrait
        if (localState.character?.portrait?.startsWith('data:')) {
            const url = await uploadImageToStorage(localState.character.portrait, `users/${uid}/portrait_${Date.now()}.jpg`);
            localState.character.portrait = url;
        }

        // 2. Upload Map Background
        if (localState.map?.backgroundImage?.startsWith('data:')) {
            const url = await uploadImageToStorage(localState.map.backgroundImage, `users/${uid}/map_${Date.now()}.jpg`);
            localState.map.backgroundImage = url;
        }

        // 3. Upload Story Illustrations (This is usually the biggest part)
        if (localState.storyLog) {
            const newStoryLog = await Promise.all(localState.storyLog.map(async (segment: any, index: number) => {
                if (segment.illustration?.startsWith('data:')) {
                    const url = await uploadImageToStorage(segment.illustration, `users/${uid}/story_${index}_${Date.now()}.jpg`);
                    return { ...segment, illustration: url };
                }
                return segment;
            }));
            localState.storyLog = newStoryLog;
        }

        const userGameRef = doc(db, "users", uid, "games", "singleplayer");
        const docSnap = await getDoc(userGameRef);
        
        if (!docSnap.exists()) {
            // Now saving the 'lightweight' version with URLs instead of raw image data
            await setDoc(userGameRef, {
                gameState: localState,
                creationData: localCreation,
                lastUpdated: serverTimestamp()
            });
            console.log("Successfully migrated local save to cloud!");
            // Optional: Clear local storage after successful migration
            // localStorage.removeItem('endlessAdventureSave'); 
        }
    } catch (e) {
        console.error("Migration failed:", e);
    }
  };

  // 1. Auth Listener
  useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
            setUser(currentUser);
            if (currentUser) {
                // 1. Try to migrate existing local data first
                await migrateLocalSaveToCloud(currentUser.uid);
                // 2. Then load the game (which will now find the migrated data)
                loadCloudGame(currentUser.uid); 
            }
        });
        return () => unsubscribe();
    }, []);

  // 2. UPDATE THIS: Update your lobby listener to save the data
  useEffect(() => {
      if (!lobbyId) return;
      const unsub = onSnapshot(doc(db, "lobbies", lobbyId), (doc) => {
          if (doc.exists()) {
              const data = doc.data() as MultiplayerLobby;
              setLobbyData(data); // <--- Save this!
              
              if (data.gameState) {
                  setGameState(data.gameState);
              }
              if (data.status === 'playing' && gameState.gameStatus === 'initial_load') {
                  setGameState(prev => ({ ...prev, gameStatus: 'playing' }));
              }
          }
      });
      return () => unsub();
  }, [lobbyId]);

  const handleLogin = async () => {
      try {
          await signInWithPopup(auth, googleProvider);
      } catch (error) {
          console.error("Login failed", error);
      }
  };

  // Replace old load logic with Firestore logic
  const loadCloudGame = async (uid: string) => {
      const docRef = doc(db, "users", uid, "games", "singleplayer");
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
          const savedData = docSnap.data();
          setGameState(savedData.gameState);
          setCreationData(savedData.creationData);
      } else {
          handleNewGame();
      }
  };

  // Replace old save logic with Firestore logic
  // Call this inside your existing useEffect or where appropriate
  const saveGameToCloud = async (stateToSave: any) => {
      if (!user) return;
      
      if (isMultiplayer && lobbyId) {
          // In multiplayer, only the "active" player or host writes mostly, 
          // but usually we update the whole lobby doc.
          await updateDoc(doc(db, "lobbies", lobbyId), {
              gameState: stateToSave
          });
      } else {
          // Single player save
          await setDoc(doc(db, "users", user.uid, "games", "singleplayer"), {
              gameState: stateToSave,
              creationData: creationData,
              lastUpdated: serverTimestamp()
          });
      }
  };

  // --- NEW: The Auto-Save Hook ---
  // Triggers whenever gameState changes (except during loading/initial)
  useEffect(() => {
      if (gameState.gameStatus !== 'initial_load' && gameState.gameStatus !== 'loading' && user) {
          const timeoutId = setTimeout(() => {
              saveGameToCloud(gameState);
          }, 1000); // Debounce save by 1s
          return () => clearTimeout(timeoutId);
      }
  }, [gameState, user, isMultiplayer, lobbyId]);

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
      setGameState(prev => ({ ...prev, gameStatus: 'initial_load' })); // Using initial_load as 'waiting' state here
  };

  // UPDATE this function in App component
  const handleActionWrapper = async (action: string) => {
        if (isMultiplayer && lobbyId && lobbyData) {
            const currentPlayerIndex = lobbyData.currentTurnIndex % lobbyData.players.length;
            const currentPlayer = lobbyData.players[currentPlayerIndex];

            // BLOCK ACTION if it's not your turn
            if (currentPlayer.uid !== user?.uid) {
                alert(`It is ${currentPlayer.displayName}'s turn!`);
                return;
            }

            // OPTIMISTIC UPDATE: Advance turn immediately locally so UI feels responsive
            // The real AI response will overwrite this later
            const nextTurnIndex = lobbyData.currentTurnIndex + 1;
            await updateDoc(doc(db, "lobbies", lobbyId), {
                currentTurnIndex: nextTurnIndex
            });
        }
        
        // Proceed with the AI action generation
        await handleAction(action);
    };

  // --- Render Logic Updates ---

  if (!user) {
      return <AuthScreen onLogin={handleLogin} />;
  }

  if (!gameState.character && !creationData && !lobbyId && gameState.gameStatus === 'initial_load') {
      return <LobbyBrowser 
          onSinglePlayer={() => { setIsMultiplayer(false); handleNewGame(); }}
          onCreate={handleCreateLobby} 
          onJoin={(id) => { setLobbyId(id); setIsMultiplayer(true); }} 
      />;
  }

  // --- UPDATED: Render the actual Waiting Room Component ---
  if (isMultiplayer && lobbyId && gameState.gameStatus === 'initial_load') {
      if (!lobbyData) return <div className="lobby-container"><Loader text="Connecting to lobby..." /></div>;
      
      return <WaitingRoom 
          lobby={lobbyData} 
          onStart={async () => {
              // Host starts the game
              await updateDoc(doc(db, "lobbies", lobbyId), { status: 'playing' });
          }} 
      />;
  }

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

  // Add a ref to track if the game has already initialized to prevent strict-mode double firing
  const hasLoaded = useRef(false);

  const generateImage = useCallback(async (prompt: string): Promise<string | null> => {
    try {
        // Step 1: Sanitize prompt via Gemini Proxy
        const promptGenerationResponse = await callGemini(
            "gemini-2.5-flash",
            `Based on the following description, create a concise, sanitized, and effective image generation prompt suitable for a fantasy art style. Focus on the key visual elements. Description: "${prompt}"`,
            {
                responseMimeType: "application/json",
                responseSchema: imagePromptSchema,
                safetySettings: safetySettings,
            }
        );
        // Note: The structure of the response might be slightly different depending on how SDK serializes it.
        // Usually, response.text is a function in the SDK, but coming from JSON it might be a property or inside candidates.
        // We handle the text extraction safely:
        let jsonText = "";
        if (promptGenerationResponse.text) {
             jsonText = promptGenerationResponse.text;
        } else if (promptGenerationResponse.candidates && promptGenerationResponse.candidates[0].content.parts[0].text) {
             jsonText = promptGenerationResponse.candidates[0].content.parts[0].text;
        }

        const sanitizedData = JSON.parse(jsonText);
        const finalPrompt = sanitizedData.prompt;

        // Step 2: Generate Image via Imagen Proxy
        const imageResponse = await callImagen(
            'imagen-4.0-fast-generate-001',
            `fantasy art, digital painting. ${finalPrompt}`,
            {
                numberOfImages: 1,
                outputMimeType: 'image/jpeg',
                aspectRatio: '16:9',
                safetySettings: safetySettings,
            }
        );

        if (!imageResponse.generatedImages || imageResponse.generatedImages.length === 0) {
            console.warn("No images generated (likely safety filter).");
            return null;
        }

        const base64Image = `data:image/jpeg;base64,${imageResponse.generatedImages[0].image.imageBytes}`;
        
        // 3. Upload to Firebase Storage immediately
        if (auth.currentUser) {
            const filename = `generated_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
            const path = `users/${auth.currentUser.uid}/generated/${filename}`;
            return await uploadImageToStorage(base64Image, path);
        }

        return base64Image; // Fallback if not logged in (shouldn't happen in game)
    } catch (error) {
        console.error("Image generation failed:", error);
        return null;
    }
  }, []);

  const handleNewGame = useCallback(() => {
      localStorage.removeItem('endlessAdventureSave');
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
        combat: null,
        loot: null,
        transaction: null,
        map: null,
      }));
  }, [setGameState, setCreationData]); // Add dependencies

  // Updated Load Logic: Prevents double-execution and redundant regeneration
  useEffect(() => {
    const loadGame = async () => {
      // Prevent double-loading in Strict Mode
      if (hasLoaded.current) return;
      hasLoaded.current = true;

      try {
        const savedStateJSON = localStorage.getItem('endlessAdventureSave');
        if (savedStateJSON) {
          const { gameState: savedGameState, creationData: savedCreationData } = JSON.parse(savedStateJSON);

          // Only regenerate portrait if absolutely missing (it should now be saved)
          if (savedGameState.character) {
              if (!savedGameState.character.portrait) {
                  savedGameState.character.portrait = await generateImage(savedGameState.character.description);
              }
              if (!savedGameState.character.maxHp) {
                  savedGameState.character.maxHp = 100;
              }
          }

          // Only regenerate map if absolutely missing
          if (savedGameState.character && !savedGameState.map) {
              // Regenerate character portrait on load if it's missing
              if (!savedGameState.character.portrait) {
                  savedGameState.character.portrait = await generateImage(savedGameState.character.description);
              }
              // *** FIX: Add maxHp if it's missing from an old save ***
              if (!savedGameState.character.maxHp) {
                  savedGameState.character.maxHp = 100;
              }
          }

          // --- FIX FOR OLD SAVES: Generate map if it doesn't exist ---
          if (savedGameState.character && !savedGameState.map) {
              console.log("Old save detected. Generating new map...");
              const mapImage = await generateImage(`A fantasy world map for a story about ${savedGameState.storyGuidance.plot}.`);
              const startingLocation: MapLocation = {
                  name: "Starting Point",
                  x: 50,
                  y: 50,
                  visited: true,
                  description: savedGameState.storyLog[0]?.text || "The beginning of your journey."
              };
              savedGameState.map = {
                  backgroundImage: mapImage,
                  locations: [startingLocation]
              };
          } else if (savedGameState.map && !savedGameState.map.backgroundImage) {
              savedGameState.map.backgroundImage = await generateImage(`A fantasy world map for a story about ${savedGameState.storyGuidance.plot}.`);
          }

          // Only regenerate illustration if missing AND we are actively playing
          if (savedGameState.gameStatus === 'playing' && savedGameState.storyLog.length > 0) {
              const lastSegment = savedGameState.storyLog[savedGameState.storyLog.length - 1];
              if (!lastSegment.illustration) {
                  lastSegment.illustration = await generateImage(`${savedGameState.storyGuidance.setting}. ${lastSegment.text}`);
              }
          }

          setGameState(prevState => ({
              ...prevState,
              ...savedGameState
          }));

          if (savedCreationData) {
            setCreationData(savedCreationData);
          }

        } else {
          handleNewGame();
        }
      } catch (error) {
        console.error("Failed to load save:", error);
        handleNewGame();
      }
    };

    loadGame();
  }, [generateImage, handleNewGame]);

  // Updated Save Logic: Tries to persist images to save costs
  useEffect(() => {
    if (gameState.gameStatus !== 'initial_load' && gameState.gameStatus !== 'loading') {
      const saveState = (includeImages: boolean) => {
          const stateToSave = {
            ...gameState,
            // Try to keep the portrait if includeImages is true
            character: gameState.character
              ? { ...gameState.character, portrait: includeImages ? gameState.character.portrait : null }
              : null,
            storyLog: gameState.storyLog.map((segment, index) => {
              // Keep the last illustration if includeImages is true
              if (index === gameState.storyLog.length - 1) {
                return includeImages ? segment : { ...segment, illustration: null };
              }
              return { ...segment, illustration: null };
            }),
            // Try to keep the map background if includeImages is true
            map: gameState.map ? { ...gameState.map, backgroundImage: includeImages ? gameState.map.backgroundImage : null } : null
          };
          
          try {
            localStorage.setItem('endlessAdventureSave', JSON.stringify({ gameState: stateToSave, creationData }));
          } catch (e) {
            // If we hit the 5MB limit, fallback to stripping images to ensure progress is saved
            if (includeImages) {
                console.warn("Save quota exceeded. Removing images from save file.");
                saveState(false);
            } else {
                console.error("Failed to save game even without images:", e);
            }
          }
      };

      // Attempt to save WITH images first
      saveState(true);
    }
  }, [gameState, creationData]);

  const handleCreateCharacter = useCallback(async (details: CreationDetails) => {
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

            Base the character's description, the initial story, the plot, and the available skill pools on all of these attributes.
            IMPORTANT: For the map, generate 5-7 key starting locations in the world of Aerthos, including Aethelgard. Populate the 'map.locations' array and specify which of these is the 'map.startingLocationName'.
            The initial story text must mention the starting location by name.
            Generate a set of starting equipment for the character and their companions, making it unique and appropriate.
            IMPORTANT: For the companions, please generate unique names and personalities. Avoid using the names Kaelen, Lyra, Elara, and Gorok.
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
            // Fallback for serialized JSON response structure
            data = JSON.parse(response.candidates[0].content.parts[0].text);
        }

        const initialCompanions: Companion[] = data.companions.map((comp: any) => {
            // Transform the skills array from the API into a key-value object
            const skillsObject = comp.skills.reduce((acc: { [key: string]: number }, skill: { skillName: string, level: number }) => {
                acc[skill.skillName] = skill.level;
                return acc;
            }, {});

            return {
                ...comp,
                skills: skillsObject, // Replace the array with the new object
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
            startingAlignment: data.character.alignment,
            startingMap: data.map,
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
            description: creationData.description,
            portrait: portrait,
            alignment: creationData.startingAlignment,
            reputation: {},
            equipment: creationData.startingEquipment,
            gold: startingGold,
        };
        const initialSegment: StorySegment = { text: creationData.initialStory.text, illustration };

        setGameState(prevState => ({
            ...prevState,
            character: newCharacter,
            storyGuidance: creationData.storyGuidance,
            skillPools: creationData.skillPools,
            storyLog: [initialSegment],
            currentActions: creationData.initialStory.actions,
            map: {
                backgroundImage: mapImage,
                locations: finalLocations
            },
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
    // Guard clause: Prevent spamming action button
    if (!gameState.character || !gameState.storyGuidance || apiIsLoading) return;
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

            If the player's action is related to a specific skill (e.g., 'Use magic to create a diversion' or 'Try to disarm the guard'), perform a skill check against a difficulty. The player's skill level should influence the success. Populate the 'skillCheck' field with the results. The 'text' field should narrate the outcome of the skill check.

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
            // Fallback for serialized JSON response structure
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
                        // MODIFY THIS LINE:
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
                skillCheck: data.skillCheck // <-- Save the skill check data
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

                // Handle equipment updates
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
                            // This assumes 'add' is the only action for 'gear' for simplicity
                            if (update.action === 'add') {
                                 updatedEquipment.gear = [...(updatedEquipment.gear || []), newEquipmentItem];
                            }
                        }
                    }
                }

                 // Handle map updates
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
                        // If alignments are becoming more different, slightly decrease relationship
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

                // Handle adding a new companion
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

        // ... rest of the function for generating story summary
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
                // Fallback for serialized JSON response structure
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
}, [gameState, generateImage, apiIsLoading]);

  const handleCombatAction = useCallback(async (action: string) => {
    // Guard clause: Prevent spamming combat button
    if (!gameState.character || !gameState.combat || apiIsLoading) return;
    setApiIsLoading(true);

    try {
        const initialPrompt = `
            You are the dungeon master in a text-based RPG. The player is in combat.
            Player's action: "${action}"

            CHARACTER:
            Name: ${gameState.character.name}
            HP: ${gameState.character.hp}
            Skills: ${Object.entries(gameState.character.skills).map(([skill, level]) => `${skill} (Lvl ${level})`).join(', ')}
            Equipment:
            - Weapon: ${gameState.character.equipment.weapon?.name} (Damage: ${gameState.character.equipment.weapon?.stats.damage})
            - Armor: ${gameState.character.equipment.armor?.name} (Damage Reduction: ${gameState.character.equipment.armor?.stats.damageReduction})

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
            // Fallback for serialized JSON response structure
            data = JSON.parse(response.candidates[0].content.parts[0].text).combatResult;
        }

        // --- Client-Side Victory Check ---
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
                // Fallback for serialized JSON response structure
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
            // Combat continues
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

  const handleLootContinue = () => {
    // This now just transitions the state, the story log is updated in handleCombatAction
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

  const handleCustomActionSubmit = (action: string) => {
      setIsCustomActionModalOpen(false);
      handleAction(action);
  };

  const handleLevelUpComplete = (updatedSkills: {[key: string]: number}) => {
      setGameState(g => {
        if (!g.character) return g;

        const pointsSpent = Object.values(updatedSkills).reduce((sum, level) => sum + level, 0) - Object.values(g.character.skills).reduce((sum, level) => sum + level, 0);

        // Calculate HP gain: 3d6 + current level
        const diceRolls = Array.from({ length: 3 }, () => Math.floor(Math.random() * 6) + 1);
        const hpGain = diceRolls.reduce((a, b) => a + b, 0) + Object.values(g.character.skills).reduce((sum, level) => sum + level, 0);

        const newMaxHp = g.character.maxHp + hpGain;

        return {
            ...g,
            character: {
                ...g.character,
                skills: updatedSkills,
                skillPoints: g.character.skillPoints - pointsSpent,
                maxHp: newMaxHp,
                hp: newMaxHp, // Heal to full on level up
            },
            gameStatus: 'playing'
        }
      });
  };

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
            // Fallback for serialized JSON response structure
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
            // Fallback for serialized JSON response structure
            data = JSON.parse(response.candidates[0].content.parts[0].text);
        }

        setGameState(prevState => {
            if (!prevState.character) return prevState;

            // Update companions with new alignment data
            const updatedCompanions = prevState.companions.map(comp => {
                const syncedComp = data.companionAlignments.find((sc: any) => sc.name === comp.name);
                return syncedComp
                    ? { ...comp, alignment: { lawfulness: syncedComp.lawfulness, goodness: syncedComp.goodness } }
                    : comp; // Keep old alignment if not found in sync data
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
            // Start from level 2 up to 16
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
    (window as any).syncAlignment = handleSyncAlignment; // Add this line

    return () => {
      window.removeEventListener('force-combat-actions', handleForceActions);
    };
  }, [handleSyncMap, handleSyncAlignment]); // The empty dependency array means this runs only once
  

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

  // 3. ADD THIS: Calculate the turn boolean
  // It is your turn if: Multiplayer is OFF OR (Lobby exists AND current player ID matches yours)
  const isMyTurn = !isMultiplayer || (!!lobbyData && !!user && lobbyData.players[lobbyData.currentTurnIndex % lobbyData.players.length]?.uid === user.uid);

  // 4. UPDATE THIS: Pass the prop in renderContent
  const renderContent = () => {
    switch (gameState.gameStatus) {
      case 'gambling':
        return <GamblingScreen 
            gameState={gameState} 
            onExit={() => setGameState(g => ({...g, gameStatus: 'playing'}))}
            onUpdateGold={handleUpdateGold}
            onAddItem={handleAddGamblingItem}
            isLoading={apiIsLoading}
            setIsLoading={setApiIsLoading}
        />;
      case 'playing':
        return <GameScreen
            gameState={gameState}
            // Use handleActionWrapper for multiplayer turn logic
            onAction={handleActionWrapper} 
            onNewGame={handleNewGame}
            onLevelUp={() => setGameState(g => ({...g, gameStatus: 'levelUp'}))}
            isLoading={apiIsLoading}
            onCustomActionClick={() => setIsCustomActionModalOpen(true)}
            onSyncHp={handleSyncHp}
            onSyncGoldAndLoot={handleSyncGoldAndLoot}
            onSyncMap={handleSyncMap}
            getAlignmentDescriptor={getAlignmentDescriptor}
            onOpenGambling={() => setGameState(g => ({...g, gameStatus: 'gambling'}))}
            isMyTurn={isMyTurn} 
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
                />;
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
                />;
      case 'combat':
          return <CombatScreen gameState={gameState} onCombatAction={handleCombatAction} isLoading={apiIsLoading} onSyncHp={handleSyncHp} />;
      case 'looting':
          if (!gameState.loot) return <Loader text="Loading loot..." />;
          return <LootScreen loot={gameState.loot} onContinue={handleLootContinue} />;
      case 'transaction':
          return <TransactionScreen gameState={gameState} onTransaction={handleTransaction} onExit={handleTransactionExit} />;
      case 'gameOver':
          return <GameOverScreen onNewGame={handleNewGame} />;
      case 'loading':
        return <Loader text="Your story is being written..." />;
      case 'initial_load':
      default:
        return <Loader text="Loading..." />;
    }
  };

  return (
    <div id="app-container">
        {isMultiplayer && (
            <div className="turn-indicator">
                Multiplayer Session | {lobbyId}
            </div>
        )}
        {renderContent()}
        <CustomActionModal
            isOpen={isCustomActionModalOpen}
            onClose={() => setIsCustomActionModalOpen(false)}
            onSubmit={(action) => { setIsCustomActionModalOpen(false); handleActionWrapper(action); }}
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