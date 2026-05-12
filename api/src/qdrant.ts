import { QdrantClient } from '@qdrant/js-client-rest'
import type { Neighbor } from './types.ts'

const COLLECTION = 'txns'

export class QdrantService {
  private client: QdrantClient

  constructor(url: string) {
    this.client = new QdrantClient({ url })
  }

  async isReady(): Promise<boolean> {
    try {
      await this.client.getCollection(COLLECTION)
      return true
    } catch {
      return false
    }
  }

  async findNeighbors(vector: number[]): Promise<Neighbor[]> {
    const result = await this.client.search(COLLECTION, {
      vector,
      limit: 5,
      with_payload: true,
    })
    return result.map(hit => ({ label: hit.payload!['label'] as 'fraud' | 'legit' }))
  }
}
