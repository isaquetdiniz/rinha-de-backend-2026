import { QdrantClient } from '@qdrant/js-client-grpc'
import type { Neighbor } from './types.ts'

const COLLECTION = 'txns'

export class QdrantService {
  private client: QdrantClient

  constructor(url: string) {
    this.client = new QdrantClient({ url })
  }

  async isReady(): Promise<boolean> {
    try {
      await this.client.api('service').healthCheck({})
      return true
    } catch {
      return false
    }
  }

  async findNeighbors(vector: number[]): Promise<Neighbor[]> {
    const result = await this.client.api('points').search({
      collectionName: COLLECTION,
      vector,
      limit: BigInt(5),
      withPayload: { selectorOptions: { case: 'enable', value: true } },
    })
    return result.result.map(hit => {
      const kind = hit.payload['label']?.kind
      const label = kind?.case === 'stringValue' ? kind.value : 'legit'
      return { label: label as 'fraud' | 'legit' }
    })
  }
}
