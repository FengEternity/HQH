'use strict';

const CATALOG_COLLECTIONS = [
  'brands',
  'products',
  'videos',
  'synonyms',
  'support_messages',
];

function errorText(error) {
  return String((error && (error.errMsg || error.message)) || '');
}

function errorCode(error) {
  return error && (error.errCode || error.code);
}

function isCollectionExistsError(error) {
  const code = errorCode(error);
  if (code === 'DATABASE_COLLECTION_EXIST' || code === -501001) {
    return true;
  }
  const msg = errorText(error);
  return (
    /already exists/i.test(msg) ||
    /ResourceExist/i.test(msg) ||
    msg.indexOf('集合已存在') >= 0
  );
}

function isCollectionMissingError(error) {
  const code = errorCode(error);
  if (code === -502005 || code === 'DATABASE_COLLECTION_NOT_EXIST') {
    return true;
  }
  const msg = errorText(error);
  return (
    /collection not exists/i.test(msg) ||
    /DATABASE_COLLECTION_NOT_EXIST/i.test(msg) ||
    /Table not exist/i.test(msg)
  );
}

async function ensureCollections(db, names) {
  const list = Array.isArray(names) && names.length ? names : CATALOG_COLLECTIONS;
  const created = [];
  const existed = [];
  for (const name of list) {
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (error) {
      if (!isCollectionExistsError(error)) {
        throw error;
      }
      existed.push(name);
    }
  }
  return { created, existed };
}

async function runWithCollections(db, fn) {
  try {
    return await fn();
  } catch (error) {
    if (!isCollectionMissingError(error)) {
      throw error;
    }
    await ensureCollections(db);
    return await fn();
  }
}

module.exports = {
  CATALOG_COLLECTIONS,
  isCollectionExistsError,
  isCollectionMissingError,
  ensureCollections,
  runWithCollections,
};
