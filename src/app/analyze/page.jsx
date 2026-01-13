'use client'

import React, { useState, useCallback, useMemo } from 'react';
import { Upload, AlertTriangle, FileCode, Network, Download, Zap, ChevronRight, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import ReactFlow, { Controls, Background, MarkerType, Position } from 'reactflow';
import 'reactflow/dist/style.css';

// Enhanced Mongoose Schema Parser
const parseMongooseSchemas = (code) => {
  const schemas = [];
  const relationships = [];
  const rawSchemaData = new Map();
  
  // Remove comments to avoid false matches
  const cleanCode = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');
  
  // Extract schema definitions - handle multiple patterns
  const patterns = [
    // const UserSchema = new Schema({ ... })
    /(?:const|let|var)\s+(\w+Schema)\s*=\s*new\s+(?:mongoose\.)?Schema\s*\(\s*\{([\s\S]*?)\}(?:\s*,\s*\{[^}]*\})?\s*\)/g,
    // const UserSchema = Schema({ ... })
    /(?:const|let|var)\s+(\w+Schema)\s*=\s*(?:mongoose\.)?Schema\s*\(\s*\{([\s\S]*?)\}(?:\s*,\s*\{[^}]*\})?\s*\)/g,
  ];
  
  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(cleanCode)) !== null) {
      const [, schemaName, content] = match;
      if (!rawSchemaData.has(schemaName)) {
        rawSchemaData.set(schemaName, content);
      }
    }
  });
  
  // Extract model definitions
  const modelPatterns = [
    /(?:module\.exports|exports)\s*=\s*mongoose\.model\s*\(\s*['"](\w+)['"]\s*,\s*(\w+Schema)/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*mongoose\.model\s*\(\s*['"](\w+)['"]\s*,\s*(\w+Schema)/g,
    /mongoose\.model\s*\(\s*['"](\w+)['"]\s*,\s*(\w+Schema)/g,
  ];
  
  const modelMap = new Map();
  modelPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(cleanCode)) !== null) {
      const modelName = match[1];
      const schemaName = match[match.length - 1]; // Last capture group is always schema name
      modelMap.set(schemaName, modelName);
    }
  });
  
  // Parse each schema for fields and relationships
  for (const [schemaName, content] of rawSchemaData.entries()) {
    const modelName = modelMap.get(schemaName) || schemaName.replace(/Schema$/i, '');
    
    // Extract all fields with their types
    const fields = [];
    const fieldPattern = /(\w+)\s*:\s*(\{[\s\S]*?\}(?=\s*,\s*\w+\s*:|$)|\[[\s\S]*?\]|[\w.]+)/g;
    let fieldMatch;
    
    while ((fieldMatch = fieldPattern.exec(content)) !== null) {
      const [, fieldName, fieldDef] = fieldMatch;
      fields.push({ name: fieldName, definition: fieldDef });
    }
    
    schemas.push({
      id: modelName,
      name: modelName,
      schemaName: schemaName,
      fields: fields.map(f => f.name)
    });
    
    // Analyze relationships in each field
    fields.forEach(({ name: fieldName, definition: fieldDef }) => {
      // Pattern 1: type: ObjectId, ref: 'Model'
      const refPattern1 = /type\s*:\s*(?:Schema\.Types\.)?ObjectId[\s\S]*?ref\s*:\s*['"](\w+)['"]/;
      const match1 = refPattern1.exec(fieldDef);
      
      if (match1) {
        const targetModel = match1[1];
        const isArray = fieldDef.trim().startsWith('[');
        
        relationships.push({
          from: modelName,
          to: targetModel,
          field: fieldName,
          type: isArray ? 'one-to-many' : 'one-to-one',
          refType: 'ObjectId',
          cascadeRisk: true
        });
      }
      
      // Pattern 2: [{ type: ObjectId, ref: 'Model' }]
      const refPattern2 = /\[\s*\{\s*type\s*:\s*(?:Schema\.Types\.)?ObjectId[\s\S]*?ref\s*:\s*['"](\w+)['"]/;
      const match2 = refPattern2.exec(fieldDef);
      
      if (match2 && !match1) {
        const targetModel = match2[1];
        
        relationships.push({
          from: modelName,
          to: targetModel,
          field: fieldName,
          type: 'one-to-many',
          refType: 'ObjectId',
          cascadeRisk: true
        });
      }
      
      // Pattern 3: Embedded schemas
      const embedPattern = /(?:type\s*:\s*)?(\w+Schema)|\[\s*(\w+Schema)\s*\]/;
      const embedMatch = embedPattern.exec(fieldDef);
      
      if (embedMatch) {
        const embeddedSchemaName = embedMatch[1] || embedMatch[2];
        const embeddedModel = modelMap.get(embeddedSchemaName) || embeddedSchemaName.replace(/Schema$/i, '');
        
        if (embeddedModel !== modelName && rawSchemaData.has(embeddedSchemaName)) {
          const isArray = fieldDef.includes('[');
          relationships.push({
            from: modelName,
            to: embeddedModel,
            field: fieldName,
            type: isArray ? 'embedded-many' : 'embedded-one',
            refType: 'Embedded',
            cascadeRisk: false
          });
        }
      }
    });
  }
  
  return { schemas, relationships };
};

// Enhanced Issue Detection
const detectIssues = (schemas, relationships) => {
  const issues = [];
  const schemaIds = new Set(schemas.map(s => s.id));
  
  // Check for broken references
  relationships.forEach(rel => {
    if (!schemaIds.has(rel.to)) {
      issues.push({
        severity: 'error',
        type: 'broken-reference',
        message: `"${rel.from}.${rel.field}" references "${rel.to}" which doesn't exist in your schemas`,
        schema: rel.from,
        field: rel.field,
        target: rel.to
      });
    }
  });
  
  // Detect circular dependencies
  const findCircularDeps = (start, current, path = [], visited = new Set()) => {
    if (path.includes(current)) {
      const cycle = [...path.slice(path.indexOf(current)), current];
      return cycle;
    }
    
    if (visited.has(current)) return null;
    visited.add(current);
    
    const outgoing = relationships.filter(r => r.from === current);
    for (const rel of outgoing) {
      const result = findCircularDeps(start, rel.to, [...path, current], visited);
      if (result) return result;
    }
    
    return null;
  };
  
  const checkedCycles = new Set();
  schemas.forEach(schema => {
    const cycle = findCircularDeps(schema.id, schema.id);
    if (cycle) {
      const cycleKey = cycle.sort().join('->');
      if (!checkedCycles.has(cycleKey)) {
        checkedCycles.add(cycleKey);
        issues.push({
          severity: 'warning',
          type: 'circular-dependency',
          message: `Circular reference detected: ${cycle.join(' → ')}`,
          schema: schema.id,
          cycle: cycle
        });
      }
    }
  });
  
  // Detect orphan risks
  const referencedSchemas = new Set(relationships.map(r => r.to));
  const referencingSchemas = new Set(relationships.map(r => r.from));
  
  schemas.forEach(schema => {
    const incoming = relationships.filter(r => r.to === schema.id);
    const outgoing = relationships.filter(r => r.from === schema.id);
    
    // Schema is only referenced by others, never references anything
    if (incoming.length > 0 && outgoing.length === 0) {
      const referencers = [...new Set(incoming.map(r => r.from))];
      issues.push({
        severity: 'warning',
        type: 'orphan-risk',
        message: `"${schema.id}" has no outgoing references. If ${referencers.join(', ')} documents are deleted, orphans may remain`,
        schema: schema.id,
        referencers
      });
    }
  });
  
  // Detect cascade deletion risks
  schemas.forEach(schema => {
    const outgoing = relationships.filter(r => r.from === schema.id && r.cascadeRisk);
    if (outgoing.length > 2) {
      issues.push({
        severity: 'info',
        type: 'cascade-risk',
        message: `"${schema.id}" references ${outgoing.length} other schemas. Consider cascade deletion strategy`,
        schema: schema.id,
        targets: outgoing.map(r => r.to)
      });
    }
  });
  
  return issues;
};

// Generate hierarchical layout for react-flow
const generateHierarchicalLayout = (schemas, relationships) => {
  const nodes = [];
  const edges = [];
  
  // Calculate node levels (depth in hierarchy)
  const levels = new Map();
  const inDegree = new Map();
  
  schemas.forEach(s => {
    inDegree.set(s.id, 0);
    levels.set(s.id, 0);
  });
  
  relationships.forEach(r => {
    if (inDegree.has(r.to)) {
      inDegree.set(r.to, inDegree.get(r.to) + 1);
    }
  });
  
  // BFS to assign levels
  const queue = schemas.filter(s => inDegree.get(s.id) === 0).map(s => s.id);
  const visited = new Set(queue);
  
  while (queue.length > 0) {
    const current = queue.shift();
    const currentLevel = levels.get(current);
    
    relationships
      .filter(r => r.from === current)
      .forEach(r => {
        if (levels.has(r.to)) {
          levels.set(r.to, Math.max(levels.get(r.to), currentLevel + 1));
        }
        if (!visited.has(r.to)) {
          visited.add(r.to);
          queue.push(r.to);
        }
      });
  }
  
  // Group nodes by level
  const levelGroups = new Map();
  levels.forEach((level, id) => {
    if (!levelGroups.has(level)) levelGroups.set(level, []);
    levelGroups.get(level).push(id);
  });
  
  // Position nodes
  const levelSpacing = 280;
  const nodeSpacing = 120;
  
  schemas.forEach(schema => {
    const level = levels.get(schema.id) || 0;
    const nodesInLevel = levelGroups.get(level) || [];
    const indexInLevel = nodesInLevel.indexOf(schema.id);
    const offsetY = (indexInLevel - (nodesInLevel.length - 1) / 2) * nodeSpacing;
    
    nodes.push({
      id: schema.id,
      type: 'default',
      data: { label: schema.name },
      position: { x: level * levelSpacing, y: offsetY },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        background: '#1a1a1a',
        border: '1px solid #3a3a3a',
        borderRadius: '8px',
        padding: '12px 16px',
        color: '#e8e8e8',
        fontSize: '13px',
        fontWeight: '500'
      }
    });
  });
  
  // Create edges
  relationships.forEach((rel, idx) => {
    const edgeColor = rel.type.includes('embedded') ? '#7a5c3a' : '#c17532';
    const strokeWidth = rel.type.includes('many') ? 2 : 1;
    
    edges.push({
      id: `${rel.from}-${rel.to}-${idx}`,
      source: rel.from,
      target: rel.to,
      label: rel.field,
      type: 'smoothstep',
      animated: rel.type.includes('many'),
      style: { stroke: edgeColor, strokeWidth },
      labelStyle: { fill: '#9b9b9b', fontSize: 10 },
      labelBgStyle: { fill: '#1a1a1a' },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edgeColor,
        width: 15,
        height: 15
      }
    });
  });
  
  return { nodes, edges };
};

// Example schemas
const EXAMPLE_SCHEMAS = `
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  posts: [{ type: Schema.Types.ObjectId, ref: 'Post' }],
  profile: { type: Schema.Types.ObjectId, ref: 'Profile' },
  createdAt: { type: Date, default: Date.now }
});

const PostSchema = new Schema({
  title: { type: String, required: true },
  content: String,
  author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  comments: [{ type: Schema.Types.ObjectId, ref: 'Comment' }],
  tags: [{ type: Schema.Types.ObjectId, ref: 'Tag' }],
  publishedAt: Date
});

const CommentSchema = new Schema({
  text: { type: String, required: true },
  author: { type: Schema.Types.ObjectId, ref: 'User' },
  post: { type: Schema.Types.ObjectId, ref: 'Post' },
  createdAt: { type: Date, default: Date.now }
});

const ProfileSchema = new Schema({
  bio: String,
  avatar: String,
  user: { type: Schema.Types.ObjectId, ref: 'User', unique: true },
  socialLinks: [String]
});

const TagSchema = new Schema({
  name: { type: String, unique: true },
  slug: String
});

mongoose.model('User', UserSchema);
mongoose.model('Post', PostSchema);
mongoose.model('Comment', CommentSchema);
mongoose.model('Profile', ProfileSchema);
mongoose.model('Tag', TagSchema);
`;

const SchemaAnalyzer = () => {
  const [schemas, setSchemas] = useState([]);
  const [relationships, setRelationships] = useState([]);
  const [issues, setIssues] = useState([]);
  const [selectedSchema, setSelectedSchema] = useState(null);
  const [uploadedCode, setUploadedCode] = useState('');
  const [view, setView] = useState('graph'); // 'graph' or 'list'

  const analyzeSchemas = useCallback((code) => {
    try {
      const { schemas: parsedSchemas, relationships: parsedRels } = parseMongooseSchemas(code);
      const detectedIssues = detectIssues(parsedSchemas, parsedRels);
      
      setSchemas(parsedSchemas);
      setRelationships(parsedRels);
      setIssues(detectedIssues);
      setUploadedCode(code);
      setView('graph');
    } catch (error) {
      console.error('Parse error:', error);
    }
  }, []);

  const { nodes, edges } = useMemo(() => {
    if (schemas.length === 0) return { nodes: [], edges: [] };
    return generateHierarchicalLayout(schemas, relationships);
  }, [schemas, relationships]);

  const handleFileUpload = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      Promise.all(
        files.map(file => 
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (event) => resolve(event.target.result);
            reader.readAsText(file);
          })
        )
      ).then(contents => {
        const combined = contents.join('\n\n');
        analyzeSchemas(combined);
      });
    }
  };

  const loadExample = () => {
    analyzeSchemas(EXAMPLE_SCHEMAS);
  };

  const exportAnalysis = () => {
    const data = {
      timestamp: new Date().toISOString(),
      summary: {
        totalSchemas: schemas.length,
        totalRelationships: relationships.length,
        issuesFound: issues.length
      },
      schemas: schemas.map(s => ({
        name: s.name,
        fields: s.fields
      })),
      relationships: relationships.map(r => ({
        from: r.from,
        to: r.to,
        field: r.field,
        type: r.type,
        refType: r.refType
      })),
      issues: issues.map(i => ({
        severity: i.severity,
        type: i.type,
        message: i.message
      }))
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `schema-analysis-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getRelationshipsForSchema = (schemaId) => {
    return {
      outgoing: relationships.filter(r => r.from === schemaId),
      incoming: relationships.filter(r => r.to === schemaId)
    };
  };

  const getSeverityIcon = (severity) => {
    switch (severity) {
      case 'error': return <XCircle className="w-4 h-4 text-[#e84545]" />;
      case 'warning': return <AlertTriangle className="w-4 h-4 text-[#e8a53a]" />;
      case 'info': return <AlertCircle className="w-4 h-4 text-[#5a9fd4]" />;
      default: return <CheckCircle className="w-4 h-4 text-[#4caf50]" />;
    }
  };

  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;

  return (
    <div className="min-h-screen bg-[#1a1a1a] text-[#e8e8e8]">
      <header className="border-b border-[#2a2a2a] bg-[#1a1a1a] sticky top-0 z-50">
        <div className="max-w-full px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Network className="w-6 h-6 text-[#c17532]" />
              <h1 className="text-xl font-medium">Schema Analyzer</h1>
            </div>
            {schemas.length > 0 && (
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-4 text-sm px-4 py-2 bg-[#1f1f1f] rounded-lg border border-[#2a2a2a]">
                  <div className="flex items-center gap-2">
                    <FileCode className="w-4 h-4 text-[#c17532]" />
                    <span className="text-[#9b9b9b]">{schemas.length} schemas</span>
                  </div>
                  {errorCount > 0 && (
                    <div className="flex items-center gap-2">
                      <XCircle className="w-4 h-4 text-[#e84545]" />
                      <span className="text-[#e84545]">{errorCount}</span>
                    </div>
                  )}
                  {warningCount > 0 && (
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-[#e8a53a]" />
                      <span className="text-[#e8a53a]">{warningCount}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 bg-[#1f1f1f] rounded-lg border border-[#2a2a2a] p-1">
                  <button
                    onClick={() => setView('graph')}
                    className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                      view === 'graph' ? 'bg-[#2a2a2a] text-[#e8e8e8]' : 'text-[#9b9b9b] hover:text-[#e8e8e8]'
                    }`}
                  >
                    Graph
                  </button>
                  <button
                    onClick={() => setView('list')}
                    className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                      view === 'list' ? 'bg-[#2a2a2a] text-[#e8e8e8]' : 'text-[#9b9b9b] hover:text-[#e8e8e8]'
                    }`}
                  >
                    Details
                  </button>
                </div>
                <button
                  onClick={exportAnalysis}
                  className="px-4 py-2 bg-[#2a2a2a] hover:bg-[#333333] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  Export
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {schemas.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 px-6">
          <div className="w-full max-w-2xl">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-medium mb-3">Understand Your Schema Relationships</h2>
              <p className="text-[#9b9b9b] text-sm leading-relaxed">
                Upload your Mongoose schema files to visualize how your collections connect, detect integrity risks, and understand your data architecture.
              </p>
            </div>

            <label className="block cursor-pointer">
              <input
                type="file"
                accept=".js,.ts"
                multiple
                onChange={handleFileUpload}
                className="hidden"
              />
              <div className="border-2 border-dashed border-[#2a2a2a] hover:border-[#3a3a3a] rounded-xl p-12 text-center transition-colors bg-[#1a1a1a]">
                <Upload className="w-12 h-12 mx-auto mb-4 text-[#9b9b9b]" />
                <p className="text-sm font-medium mb-2">Drop schema files here or click to upload</p>
                <p className="text-xs text-[#9b9b9b]">Supports multiple .js files with Mongoose schemas</p>
              </div>
            </label>

            <div className="mt-6 text-center">
              <button
                onClick={loadExample}
                className="text-sm text-[#c17532] hover:text-[#d88a4a] font-medium transition-colors inline-flex items-center gap-2"
              >
                <Zap className="w-4 h-4" />
                Load example project
              </button>
            </div>
          </div>
        </div>
      ) : view === 'graph' ? (
        <div className="h-[calc(100vh-73px)] bg-[#1a1a1a]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            minZoom={0.1}
            maxZoom={2}
            defaultEdgeOptions={{
              type: 'smoothstep',
            }}
          >
            <Background color="#2a2a2a" gap={16} />
            <Controls 
              style={{
                button: { background: '#2a2a2a', borderColor: '#3a3a3a', color: '#e8e8e8' }
              }}
            />
          </ReactFlow>
          
          {issues.length > 0 && (
            <div className="absolute bottom-4 right-4 w-96 bg-[#1f1f1f] border border-[#2a2a2a] rounded-xl p-4 shadow-2xl max-h-[400px] overflow-y-auto">
              <h3 className="font-medium mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-[#e8a53a]" />
                Issues Detected ({issues.length})
              </h3>
              <div className="space-y-2">
                {issues.map((issue, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-sm"
                  >
                    <div className="flex items-start gap-2 mb-1">
                      {getSeverityIcon(issue.severity)}
                      <div className="flex-1">
                        <div className="font-medium text-xs uppercase tracking-wide mb-1 text-[#9b9b9b]">
                          {issue.type.replace('-', ' ')}
                        </div>
                        <div className="text-[#e8e8e8] leading-snug">{issue.message}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-4">
              <div className="bg-[#1f1f1f] rounded-xl border border-[#2a2a2a] p-5">
                <h3 className="font-medium mb-4 flex items-center gap-2">
                  <FileCode className="w-4 h-4 text-[#c17532]" />
                  Schemas ({schemas.length})
                </h3>
                <div className="space-y-2">
                  {schemas.map(schema => {
                    const rels = getRelationshipsForSchema(schema.id);
                    const schemaIssues = issues.filter(i => i.schema === schema.id);
                    
                    return (
                      <button
                        key={schema.id}
                        onClick={() => setSelectedSchema(schema.id)}
                        className={`w-full text-left px-4 py-3 rounded-lg transition-all ${
                          selectedSchema === schema.id
                            ? 'bg-[#2a2a2a] border border-[#3a3a3a]'
                            : 'bg-[#1a1a1a] border border-[#2a2a2a] hover:border-[#3a3a3a]'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm truncate">{schema.name}</div>
                            <div className="text-xs text-[#9b9b9b] mt-1">
                              {rels.outgoing.length} out · {rels.incoming.length} in
                            </div>
                          </div>
                          {schemaIssues.length > 0 && (
                            <div className="flex items-center gap-1 ml-2">
                              {schemaIssues.some(i => i.severity === 'error') && (
                                <XCircle className="w-4 h-4 text-[#e84545]" />
                              )}
                              {schemaIssues.some(i => i.severity === 'warning') && (
                                <AlertTriangle className="w-4 h-4 text-[#e8a53a]" />
                              )}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="lg:col-span-2">
              {selectedSchema ? (
                <div className="bg-[#1f1f1f] rounded-xl border border-[#2a2a2a] p-6">
                  <h2 className="text-xl font-medium mb-6">{selectedSchema}</h2>
                  
                  {(() => {
                    const rels = getRelationshipsForSchema(selectedSchema);
                    const schemaIssues = issues.filter(i => i.schema === selectedSchema);
                    
                    return (
                      <div className="space-y-6">
                        {schemaIssues.length > 0 && (
                          <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4">
                            <h3 className="font-medium text-sm mb-3 flex items-center gap-2">
                              <AlertTriangle className="w-4 h-4 text-[#e8a53a]" />
                              Issues ({schemaIssues.length})
                            </h3>
                            <div className="space-y-2">
                              {schemaIssues.map((issue, idx) => (
                                <div key={idx} className="flex items-start gap-2 text-sm">
                                  {getSeverityIcon(issue.severity)}
                                  <div className="flex-1">
                                    <div className="text-[#e8e8e8]">{issue.message}</div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {rels.outgoing.length > 0 && (
                          <div>
                            <h3 className="text-sm font-medium text-[#9b9b9b] uppercase tracking-wide mb-3">
                              References to other schemas
                            </h3>
                            <div className="space-y-2">
                              {rels.outgoing.map((rel, idx) => (
                                <div
                                  key={idx}
                                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4"
                                >
                                  <div className="flex items-start justify-between">
                                    <div className="flex-1">
                                      <div className="flex items-center gap-2 mb-1">
                                        <code className="text-sm font-mono text-[#c17532]">{rel.field}</code>
                                        <span className="text-xs px-2 py-0.5 bg-[#2a2a2a] rounded text-[#9b9b9b]">
                                          {rel.type}
                                        </span>
                                      </div>
                                      <div className="text-sm text-[#9b9b9b] flex items-center gap-2">
                                        <ChevronRight className="w-3 h-3" />
                                        <span className="text-[#e8e8e8] font-medium">{rel.to}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {rels.incoming.length > 0 && (
                          <div>
                            <h3 className="text-sm font-medium text-[#9b9b9b] uppercase tracking-wide mb-3">
                              Referenced by other schemas
                            </h3>
                            <div className="space-y-2">
                              {rels.incoming.map((rel, idx) => (
                                <div
                                  key={idx}
                                  className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4"
                                >
                                  <div className="flex items-start justify-between">
                                    <div className="flex-1">
                                      <div className="text-sm text-[#9b9b9b] mb-1">
                                        <span className="text-[#e8e8e8] font-medium">{rel.from}</span>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        <code className="text-sm font-mono text-[#c17532]">{rel.field}</code>
                                        <span className="text-xs px-2 py-0.5 bg-[#2a2a2a] rounded text-[#9b9b9b]">
                                          {rel.type}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {rels.outgoing.length === 0 && rels.incoming.length === 0 && schemaIssues.length === 0 && (
                          <div className="text-center py-8 text-[#9b9b9b] text-sm">
                            No relationships or issues detected for this schema
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="bg-[#1f1f1f] rounded-xl border border-[#2a2a2a] p-12 text-center">
                  <Network className="w-12 h-12 mx-auto mb-4 text-[#9b9b9b]" />
                  <p className="text-[#9b9b9b]">Select a schema to view details</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SchemaAnalyzer;